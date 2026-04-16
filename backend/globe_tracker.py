"""
Globe tracking: live cargo flights (OpenSky) + vessels (aisstream.io WebSocket).
"""
import asyncio
import json
import logging
from datetime import datetime, timezone

import httpx

logger = logging.getLogger(__name__)

# ─── In-memory caches ─────────────────────────────────────────────────────────

_flights: list = []
_flights_updated: str | None = None

_vessels: dict = {}          # mmsi → vessel dict
_vessels_updated: str | None = None

_ais_task: asyncio.Task | None = None
_ais_api_key: str = ""


# ─── Flights (OpenSky Network — no API key needed) ────────────────────────────

# ICAO airline prefixes for major cargo/freight operators
CARGO_PREFIXES = {
    "UPS", "FDX", "ABX", "ATN", "GTI", "CLX", "MPH", "DHL",
    "DHX", "TNT", "PAC", "KZR", "SQC", "AAL", "CPA", "CKS",
    "NCA", "ANA", "KLM", "BAW", "QFA", "EIN", "TAM",
}

OPENSKY_URL = "https://opensky-network.org/api/states/all"


async def refresh_flights() -> None:
    global _flights, _flights_updated
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(OPENSKY_URL, headers={"User-Agent": "SIGNAL/1.0"})
        data = resp.json()
        states = data.get("states") or []

        result = []
        for s in states:
            # [icao24, callsign, origin_country, time_pos, last_contact,
            #  lng, lat, baro_alt, on_ground, velocity, true_track, vert_rate,
            #  sensors, geo_alt, squawk, spi, position_source]
            if len(s) < 11:
                continue
            callsign = (s[1] or "").strip()
            if not callsign:
                continue
            if s[8]:  # on_ground
                continue
            lat, lng = s[6], s[5]
            if not lat or not lng:
                continue
            prefix = callsign[:3].upper()
            if prefix not in CARGO_PREFIXES:
                continue

            alt_m = s[7] or s[13] or 0
            vel_ms = s[9] or 0
            result.append({
                "icao24": s[0],
                "callsign": callsign,
                "country": s[2] or "",
                "lat": round(lat, 4),
                "lng": round(lng, 4),
                "altitude_ft": round(alt_m * 3.281) if alt_m else None,
                "speed_kts": round(vel_ms * 1.944) if vel_ms else None,
                "heading": round(s[10]) if s[10] is not None else None,
            })

        _flights = result
        _flights_updated = datetime.now(timezone.utc).isoformat()
        logger.info(f"Flights: {len(result)} cargo aircraft")
    except Exception as e:
        logger.warning(f"OpenSky fetch error: {e}")


# ─── Vessels (aisstream.io WebSocket) ─────────────────────────────────────────

# Focus on major chokepoints — keeps message volume manageable on free tier
AIS_BBOXES = [
    [[10.0, 38.0], [26.0, 46.0]],   # Red Sea + Bab-el-Mandeb
    [[8.0, 42.0],  [16.0, 65.0]],   # Gulf of Aden
    [[22.0, 47.0], [30.0, 62.0]],   # Persian Gulf + Hormuz
    [[-2.0, 95.0], [8.0, 108.0]],   # Strait of Malacca
    [[6.0, -82.0], [12.0, -74.0]],  # Panama Canal approach
    [[-38.0, 16.0],[32.0, 36.0]],   # Suez / Eastern Med
    [[-60.0,-70.0],[-10.0, 20.0]],  # Cape of Good Hope
]

# AIS ship type codes to include (tankers, bulk, container, general cargo)
VESSEL_TYPES = set(range(70, 90))  # 70-89: cargo/tanker


async def _ais_ws_loop(api_key: str) -> None:
    """Persistent WebSocket connection to aisstream.io with reconnection."""
    global _vessels, _vessels_updated
    import websockets  # already in requirements

    subscribe = json.dumps({
        "APIKey": api_key,
        "BoundingBoxes": AIS_BBOXES,
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    })

    while True:
        try:
            async with websockets.connect(
                "wss://stream.aisstream.io/v0/stream",
                ping_interval=30,
                ping_timeout=10,
            ) as ws:
                await ws.send(subscribe)
                logger.info("AIS WebSocket connected")

                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                        mtype = msg.get("MessageType")
                        meta = msg.get("MetaData", {})
                        mmsi = str(meta.get("MMSI", ""))
                        if not mmsi:
                            continue

                        if mtype == "PositionReport":
                            pos = msg.get("Message", {}).get("PositionReport", {})
                            ship_type = int(meta.get("ShipType") or 0)
                            if ship_type not in VESSEL_TYPES and ship_type != 0:
                                continue
                            entry = _vessels.get(mmsi, {})
                            entry.update({
                                "mmsi": mmsi,
                                "lat": round(meta.get("latitude", 0), 4),
                                "lng": round(meta.get("longitude", 0), 4),
                                "heading": pos.get("TrueHeading") or pos.get("Cog"),
                                "speed_kts": pos.get("Sog"),
                                "ship_type": ship_type,
                                "updated": datetime.now(timezone.utc).isoformat(),
                            })
                            _vessels[mmsi] = entry
                            _vessels_updated = datetime.now(timezone.utc).isoformat()

                        elif mtype == "ShipStaticData":
                            static = msg.get("Message", {}).get("ShipStaticData", {})
                            entry = _vessels.get(mmsi, {})
                            entry.update({
                                "mmsi": mmsi,
                                "name": (meta.get("ShipName") or static.get("Name") or "").strip(),
                                "ship_type": int(static.get("Type") or meta.get("ShipType") or 0),
                                "destination": (static.get("Destination") or "").strip(),
                                "flag": meta.get("Flag") or "",
                                "callsign": (static.get("CallSign") or "").strip(),
                            })
                            _vessels[mmsi] = entry

                    except Exception:
                        pass

                    # Prune stale entries (>30 min old) periodically
                    if len(_vessels) > 2000:
                        cutoff = datetime.now(timezone.utc).timestamp() - 1800
                        _vessels = {
                            k: v for k, v in _vessels.items()
                            if v.get("updated", "") > datetime.fromtimestamp(
                                cutoff, timezone.utc
                            ).isoformat()
                        }

        except Exception as e:
            logger.warning(f"AIS WebSocket error: {e} — reconnecting in 30s")
            await asyncio.sleep(30)


async def start_ais_stream(api_key: str) -> None:
    global _ais_task, _ais_api_key
    if not api_key or api_key == _ais_api_key and _ais_task and not _ais_task.done():
        return
    _ais_api_key = api_key
    if _ais_task and not _ais_task.done():
        _ais_task.cancel()
    _ais_task = asyncio.create_task(_ais_ws_loop(api_key))
    logger.info("AIS stream task started")


# ─── Public getters ───────────────────────────────────────────────────────────

def get_flights_data() -> dict:
    return {"flights": _flights, "updated_at": _flights_updated, "count": len(_flights)}


def get_vessels_data() -> dict:
    vessels = [v for v in _vessels.values() if v.get("lat") and v.get("lng")]
    return {"vessels": vessels, "updated_at": _vessels_updated, "count": len(vessels)}
