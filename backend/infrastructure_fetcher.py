import asyncio
import json
import logging
from datetime import datetime

import httpx
import aiosqlite

from database import DB_PATH

logger = logging.getLogger(__name__)

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_TIMEOUT = 180

# ─── Influence scoring ────────────────────────────────────────────────────────

BASE_INFLUENCE = {
    'oil_field': 6, 'refinery': 7, 'lng_terminal': 7, 'gas_plant': 5,
    'nuclear': 6, 'energy_facility': 4,
    'mine_gold': 6, 'mine_copper': 7, 'mine_cobalt': 8, 'mine_iron': 5,
    'mine_coal': 4, 'mine_lithium': 8, 'mine_nickel': 6, 'mine_aluminum': 5,
    'mine': 3,
    'grain_wheat': 6, 'grain_corn': 6, 'grain_soy': 6, 'grain_rice': 5,
    'agriculture': 3,
}

COUNTRY_BONUS = {
    'Saudi Arabia': 3, 'Qatar': 3, 'Iran': 2, 'Iraq': 2, 'Russia': 2,
    'UAE': 2, 'Kuwait': 2, 'Libya': 2,
    'Chile': 2, 'DRC': 2, 'Peru': 1,
    'China': 1, 'India': 1, 'USA': 1, 'Australia': 1, 'Canada': 1,
    'Brazil': 1, 'Kazakhstan': 1, 'Venezuela': 1,
    'Norway': 1, 'Nigeria': 1, 'Angola': 1, 'Algeria': 1,
    'Zambia': 1, 'Indonesia': 1, 'Philippines': 1,
    'Mexico': 1, 'South Africa': 1, 'Ukraine': 1,
}

ISO2_COUNTRY = {
    'SA': 'Saudi Arabia', 'QA': 'Qatar', 'IR': 'Iran', 'IQ': 'Iraq',
    'RU': 'Russia', 'AE': 'UAE', 'KW': 'Kuwait', 'LY': 'Libya',
    'CL': 'Chile', 'CD': 'DRC', 'PE': 'Peru', 'CN': 'China',
    'IN': 'India', 'US': 'USA', 'AU': 'Australia', 'CA': 'Canada',
    'BR': 'Brazil', 'KZ': 'Kazakhstan', 'VE': 'Venezuela',
    'NO': 'Norway', 'NG': 'Nigeria', 'AO': 'Angola', 'DZ': 'Algeria',
    'ZM': 'Zambia', 'ID': 'Indonesia', 'PH': 'Philippines',
    'MX': 'Mexico', 'ZA': 'South Africa', 'UA': 'Ukraine',
    'DE': 'Germany', 'FR': 'France', 'GB': 'UK', 'IT': 'Italy',
    'JP': 'Japan', 'KR': 'South Korea', 'TR': 'Turkey',
    'EG': 'Egypt', 'OM': 'Oman', 'YE': 'Yemen',
    'PK': 'Pakistan', 'MM': 'Myanmar', 'TH': 'Thailand',
    'MY': 'Malaysia', 'VN': 'Vietnam', 'AR': 'Argentina',
    'CO': 'Colombia', 'EC': 'Ecuador', 'BO': 'Bolivia',
}


def _get_country(tags: dict) -> str:
    code = tags.get('addr:country', tags.get('is_in:country_code', '')).upper()
    if code in ISO2_COUNTRY:
        return ISO2_COUNTRY[code]
    return tags.get('addr:country_code', tags.get('is_in:country', ''))


# ─── Feature classifiers ──────────────────────────────────────────────────────

def classify_energy_feature(tags: dict) -> str:
    industrial = tags.get('industrial', '').lower()
    plant_source = tags.get('plant:source', '').lower()
    man_made = tags.get('man_made', '').lower()
    substance = tags.get('substance', '').lower()
    name_lower = tags.get('name', '').lower()

    if 'nuclear' in plant_source:
        return 'nuclear'
    if industrial in ('refinery', 'oil_refinery') or 'refinery' in name_lower or 'refining' in name_lower:
        return 'refinery'
    if industrial in ('lng_terminal', 'lng') or 'lng' in name_lower or substance in ('lng', 'liquefied_natural_gas'):
        return 'lng_terminal'
    if industrial in ('gas', 'gas_plant', 'gas_processing', 'gas_production') or 'gas plant' in name_lower or 'gas processing' in name_lower:
        return 'gas_plant'
    if industrial in ('oil', 'petroleum', 'petrol') or man_made == 'petroleum_well':
        return 'oil_field'
    return 'energy_facility'


def classify_mining_feature(tags: dict) -> str:
    resource_raw = tags.get('resource', tags.get('mine:resource', tags.get('mineral', '')))
    resource = resource_raw.lower() if resource_raw else ''
    name_lower = tags.get('name', '').lower()

    RESOURCE_MAP = [
        (['gold', 'au '], 'mine_gold'),
        (['copper', 'cu '], 'mine_copper'),
        (['cobalt', 'co '], 'mine_cobalt'),
        (['iron', 'magnetite', 'hematite'], 'mine_iron'),
        (['coal', 'lignite'], 'mine_coal'),
        (['lithium', 'li '], 'mine_lithium'),
        (['nickel', 'ni '], 'mine_nickel'),
        (['alumin', 'bauxite'], 'mine_aluminum'),
        (['zinc'], 'mine'),
        (['lead'], 'mine'),
        (['silver', 'ag '], 'mine_gold'),
        (['platinum', 'palladium'], 'mine_gold'),
        (['uranium'], 'mine'),
    ]

    for keywords, ftype in RESOURCE_MAP:
        if any(kw in resource for kw in keywords) or any(kw in name_lower for kw in keywords):
            return ftype

    return 'mine'


def classify_agriculture_feature(tags: dict) -> str:
    crop = tags.get('crop', tags.get('produce', tags.get('agricultural', ''))).lower()
    name_lower = tags.get('name', '').lower()

    AG_MAP = [
        (['wheat', 'grain', 'cereal', 'barley', 'rye'], 'grain_wheat'),
        (['corn', 'maize'], 'grain_corn'),
        (['soy', 'soybean'], 'grain_soy'),
        (['rice', 'paddy'], 'grain_rice'),
    ]

    for keywords, ftype in AG_MAP:
        if any(kw in crop for kw in keywords) or any(kw in name_lower for kw in keywords):
            return ftype

    return 'agriculture'


def assign_influence(feature_type: str, country: str, tags: dict) -> int:
    base = BASE_INFLUENCE.get(feature_type, 3)
    bonus = COUNTRY_BONUS.get(country, 0)
    name_lower = tags.get('name', '').lower()
    cap_bonus = 1 if any(x in name_lower for x in ['major', 'large', 'grand', 'national', 'giant', 'super']) else 0
    return min(10, max(1, base + bonus + cap_bonus))


# ─── Overpass helpers ─────────────────────────────────────────────────────────

async def overpass_query(query: str) -> list:
    """Execute an Overpass query and return the elements list."""
    async with httpx.AsyncClient(timeout=OVERPASS_TIMEOUT) as client:
        resp = await client.post(OVERPASS_URL, data={'data': query})
        resp.raise_for_status()
        data = resp.json()
        return data.get('elements', [])


def _extract_center(el: dict):
    """Return (lat, lng) from a node or way/relation with center."""
    if el['type'] == 'node':
        return el.get('lat'), el.get('lon')
    center = el.get('center', {})
    return center.get('lat'), center.get('lon')


def _extract_geometry(el: dict):
    """Return GeoJSON geometry dict for polygon features."""
    geom = el.get('geometry', [])
    if not geom:
        return None
    coords = [[g['lon'], g['lat']] for g in geom]
    if coords and coords[0] != coords[-1]:
        coords.append(coords[0])  # close polygon
    return {'type': 'Polygon', 'coordinates': [coords]}


def _polygon_centroid(geom_list: list):
    """Simple centroid of polygon vertices."""
    if not geom_list:
        return None, None
    lats = [g['lat'] for g in geom_list]
    lons = [g['lon'] for g in geom_list]
    return sum(lats) / len(lats), sum(lons) / len(lons)


# ─── Fetch functions ──────────────────────────────────────────────────────────

async def fetch_energy() -> list:
    logger.info("Fetching energy infrastructure from Overpass...")
    query = """
[out:json][timeout:180][maxsize:67108864];
(
  node["industrial"="refinery"]["name"];
  way["industrial"="refinery"]["name"];
  relation["industrial"="refinery"]["name"];
  node["man_made"="works"]["industrial"="oil"]["name"];
  way["man_made"="works"]["industrial"="oil"]["name"];
  node["power"="plant"]["plant:source"="nuclear"]["name"];
  way["power"="plant"]["plant:source"="nuclear"]["name"];
  relation["power"="plant"]["plant:source"="nuclear"]["name"];
  node["industrial"="lng_terminal"]["name"];
  way["industrial"="lng_terminal"]["name"];
  node["industrial"="lng"]["name"];
  way["industrial"="lng"]["name"];
  node["industrial"="gas"]["name"];
  way["industrial"="gas"]["name"];
  node["man_made"="petroleum_well"]["name"];
  way["man_made"="petroleum_well"]["name"];
  node["industrial"="oil"]["name"];
  way["industrial"="oil"]["name"];
);
out center;
"""
    try:
        elements = await overpass_query(query)
    except Exception as e:
        logger.error(f"Energy Overpass query failed: {e}")
        return []

    features = []
    seen = set()
    for el in elements:
        tags = el.get('tags', {})
        name = tags.get('name', '').strip()
        if not name or len(name) < 3:
            continue
        osm_id = f"{el['type']}/{el['id']}"
        if osm_id in seen:
            continue
        seen.add(osm_id)

        lat, lng = _extract_center(el)
        if lat is None or lng is None:
            continue

        ftype = classify_energy_feature(tags)
        country = _get_country(tags)
        influence = assign_influence(ftype, country, tags)

        features.append({
            'osm_id': osm_id,
            'feature_type': ftype,
            'name': name,
            'country': country,
            'operator': tags.get('operator', tags.get('owner', '')),
            'geometry_type': 'Point',
            'lat': lat,
            'lng': lng,
            'geometry_json': None,
            'influence': influence,
            'capacity_note': tags.get('capacity', tags.get('output', '')),
            'tags_json': json.dumps(tags),
        })

    logger.info(f"Fetched {len(features)} energy features")
    return features


async def fetch_mining() -> list:
    logger.info("Fetching mining infrastructure from Overpass...")
    query = """
[out:json][timeout:180][maxsize:67108864];
(
  node["man_made"="mine"]["name"];
  way["man_made"="mine"]["name"];
  relation["man_made"="mine"]["name"];
  node["landuse"="quarry"]["name"]["mine:resource"];
  way["landuse"="quarry"]["name"]["mine:resource"];
  node["industrial"="mine"]["name"];
  way["industrial"="mine"]["name"];
  node["landuse"="quarry"]["name"]["resource"];
  way["landuse"="quarry"]["name"]["resource"];
);
out center;
"""
    try:
        elements = await overpass_query(query)
    except Exception as e:
        logger.error(f"Mining Overpass query failed: {e}")
        return []

    features = []
    seen = set()
    for el in elements:
        tags = el.get('tags', {})
        name = tags.get('name', '').strip()
        if not name or len(name) < 3:
            continue
        osm_id = f"{el['type']}/{el['id']}"
        if osm_id in seen:
            continue
        seen.add(osm_id)

        lat, lng = _extract_center(el)
        if lat is None or lng is None:
            continue

        ftype = classify_mining_feature(tags)
        country = _get_country(tags)
        influence = assign_influence(ftype, country, tags)

        features.append({
            'osm_id': osm_id,
            'feature_type': ftype,
            'name': name,
            'country': country,
            'operator': tags.get('operator', tags.get('owner', '')),
            'geometry_type': 'Point',
            'lat': lat,
            'lng': lng,
            'geometry_json': None,
            'influence': influence,
            'capacity_note': tags.get('capacity', tags.get('production', '')),
            'tags_json': json.dumps(tags),
        })

    logger.info(f"Fetched {len(features)} mining features")
    return features


# Key agricultural regions: (south, west, north, east, label)
AG_BBOXES = [
    (44, 22, 53, 42, "Ukraine"),
    (35, -105, 50, -80, "USA_Midwest"),
    (-30, -60, 5, -35, "Brazil"),
    (-40, -65, -20, -50, "Argentina"),
    (44, 32, 60, 60, "Russia_South"),
    (18, 70, 35, 88, "India_Gangetic"),
    (-40, 110, -15, 155, "Australia"),
    (25, 100, 45, 125, "China_Yangtze"),
    (35, 25, 45, 45, "Turkey_Anatolia"),
    (-35, 17, -22, 32, "South_Africa"),
    (4, -18, 20, 10, "West_Africa"),
]


async def fetch_agriculture() -> list:
    logger.info("Fetching agriculture polygons from Overpass...")
    all_features = []

    for s, w, n, e, label in AG_BBOXES:
        bbox = f"{s},{w},{n},{e}"
        query = f"""
[out:json][timeout:60][maxsize:20000000];
(
  way["landuse"="farmland"]["name"]({bbox});
  way["landuse"="farmland"]["crop"]({bbox});
  relation["landuse"="farmland"]["name"]({bbox});
);
out geom;
"""
        try:
            elements = await overpass_query(query)
        except Exception as e:
            logger.warning(f"Agriculture query failed for {label}: {e}")
            continue

        seen = set()
        for el in elements:
            tags = el.get('tags', {})
            name = tags.get('name', tags.get('crop', '')).strip()
            if not name or len(name) < 2:
                continue
            osm_id = f"{el['type']}/{el['id']}"
            if osm_id in seen:
                continue
            seen.add(osm_id)

            geom_list = el.get('geometry', [])
            if geom_list:
                lat, lng = _polygon_centroid(geom_list)
                geom_json = json.dumps(_extract_geometry(el))
            else:
                lat, lng = _extract_center(el)
                geom_json = None

            if lat is None or lng is None:
                continue

            ftype = classify_agriculture_feature(tags)
            country = _get_country(tags)
            influence = assign_influence(ftype, country, tags)

            all_features.append({
                'osm_id': osm_id,
                'feature_type': ftype,
                'name': name,
                'country': country,
                'operator': '',
                'geometry_type': 'Polygon' if geom_list else 'Point',
                'lat': lat,
                'lng': lng,
                'geometry_json': geom_json,
                'influence': influence,
                'capacity_note': tags.get('area', ''),
                'tags_json': json.dumps(tags),
            })

        await asyncio.sleep(1)  # be polite to Overpass

    logger.info(f"Fetched {len(all_features)} agriculture features")
    return all_features


# ─── Storage ──────────────────────────────────────────────────────────────────

async def store_features(features: list):
    if not features:
        return
    now = datetime.utcnow().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        for f in features:
            await db.execute(
                """INSERT OR REPLACE INTO infrastructure_features
                   (osm_id, feature_type, name, country, operator, geometry_type,
                    lat, lng, geometry_json, influence, capacity_note, tags_json, fetched_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    f['osm_id'], f['feature_type'], f['name'], f['country'],
                    f['operator'], f['geometry_type'], f['lat'], f['lng'],
                    f['geometry_json'], f['influence'], f['capacity_note'],
                    f['tags_json'], now
                )
            )
        await db.commit()
    logger.info(f"Stored {len(features)} infrastructure features")


# ─── Orchestrator ─────────────────────────────────────────────────────────────

async def run_infrastructure_refresh():
    logger.info("Starting infrastructure data refresh...")
    try:
        energy = await fetch_energy()
        await store_features(energy)
    except Exception as e:
        logger.error(f"Energy fetch error: {e}")

    try:
        mining = await fetch_mining()
        await store_features(mining)
    except Exception as e:
        logger.error(f"Mining fetch error: {e}")

    try:
        agriculture = await fetch_agriculture()
        await store_features(agriculture)
    except Exception as e:
        logger.error(f"Agriculture fetch error: {e}")

    logger.info("Infrastructure refresh complete.")
