import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  MapContainer, TileLayer, Polyline, CircleMarker, GeoJSON, Marker, Tooltip, useMapEvents
} from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { api } from '../lib/api'
import tradeRoutes from '../data/trade_routes.json'
import capitals from '../data/capitals.json'

// ─── Module-level color config (synced from settings each render) ─────────────

const _gc = {
  bullish: '#00ff88', bearish: '#ff3b3b', neutral: '#8888aa',
  routeNoSignal: '#3d5a73', routeNormal: '#00ff88',
  routeElevated: '#ff6b00', routeHigh: '#ff3b3b',
  energy: '#ff9500', mining: '#5b8db8', agriculture: '#a8c240',
}

// ─── Type mappings ────────────────────────────────────────────────────────────

const ENERGY_TYPES = new Set(['oil_field', 'refinery', 'lng_terminal', 'gas_plant', 'nuclear', 'energy_facility'])
const MINING_TYPES = new Set(['mine_gold', 'mine_copper', 'mine_cobalt', 'mine_iron', 'mine_coal', 'mine_lithium', 'mine_nickel', 'mine_aluminum', 'mine'])
const AG_TYPES = new Set(['grain_wheat', 'grain_corn', 'grain_soy', 'grain_rice', 'agriculture'])

const INSTRUMENT_TO_TYPES = {
  USOIL: ['oil_field', 'refinery', 'lng_terminal'],
  BRENT: ['oil_field', 'refinery', 'lng_terminal'],
  CL: ['oil_field', 'refinery'],
  NGAS: ['gas_plant', 'lng_terminal'],
  LNG: ['lng_terminal', 'gas_plant'],
  OIL: ['oil_field', 'refinery'],
  GAS: ['gas_plant', 'lng_terminal'],
  GOLD: ['mine_gold'],
  GC: ['mine_gold'],
  SILVER: ['mine_gold'],
  COPPER: ['mine_copper'],
  HG: ['mine_copper'],
  WHEAT: ['grain_wheat'],
  ZW: ['grain_wheat'],
  CORN: ['grain_corn'],
  ZC: ['grain_corn'],
  SOYBEAN: ['grain_soy'],
  ZS: ['grain_soy'],
  COAL: ['mine_coal'],
  LITHIUM: ['mine_lithium'],
  NICKEL: ['mine_nickel'],
  COBALT: ['mine_cobalt'],
  IRON: ['mine_iron'],
  ALUMINUM: ['mine_aluminum'],
  ALUMINIUM: ['mine_aluminum'],
  URANIUM: ['mine'],
  PLATINUM: ['mine_gold'],
  PALLADIUM: ['mine_gold'],
}

const INDUSTRY_TO_TYPES = {
  // 'energy' is intentionally generic — only matches the catch-all type.
  // Specific sub-industries (oil, gas, nuclear) match their own infra types.
  energy: ['energy_facility'],
  oil: ['oil_field', 'refinery'],
  gas: ['gas_plant', 'lng_terminal'],
  nuclear: ['nuclear'],
  mining: ['mine_gold', 'mine_copper', 'mine_cobalt', 'mine_iron', 'mine_coal', 'mine_lithium', 'mine_nickel', 'mine_aluminum', 'mine'],
  metals: ['mine_gold', 'mine_copper', 'mine_iron', 'mine_nickel', 'mine_aluminum'],
  commodities: ['oil_field', 'refinery', 'mine_copper', 'mine_gold', 'grain_wheat'],
  agriculture: ['grain_wheat', 'grain_corn', 'grain_soy', 'grain_rice', 'agriculture'],
  food: ['grain_wheat', 'grain_corn', 'grain_soy', 'grain_rice', 'agriculture'],
  shipping: [],
  finance: [],
}

// ─── Utility functions ────────────────────────────────────────────────────────

function bezierArcPath(from, to, numPoints = 18) {
  const [lat1, lng1] = from
  const [lat2, lng2] = to
  const dLat = lat2 - lat1
  const dLng = lng2 - lng1
  const dist = Math.sqrt(dLat * dLat + dLng * dLng)
  if (dist < 0.5) return [[lat1, lng1], [lat2, lng2]]

  const midLat = (lat1 + lat2) / 2
  const midLng = (lng1 + lng2) / 2
  const offset = Math.min(dist * 0.35, 20)
  const perpLat = midLat - (dLng / dist) * offset
  const perpLng = midLng + (dLat / dist) * offset

  const pts = []
  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints
    const mt = 1 - t
    pts.push([
      mt * mt * lat1 + 2 * mt * t * perpLat + t * t * lat2,
      mt * mt * lng1 + 2 * mt * t * perpLng + t * t * lng2,
    ])
  }
  return pts
}

function getLocationCoords(locName, lat, lng) {
  if (!locName) return (lat != null && lng != null) ? [lat, lng] : null
  const lower = locName.toLowerCase().trim()
  for (const [country, data] of Object.entries(capitals)) {
    if (country.toLowerCase() === lower) return [data.lat, data.lng]
  }
  for (const [country, data] of Object.entries(capitals)) {
    const cl = country.toLowerCase()
    if ((cl.length > 4 && lower.includes(cl)) || (lower.length > 4 && cl.includes(lower))) {
      return [data.lat, data.lng]
    }
  }
  return (lat != null && lng != null) ? [lat, lng] : null
}

function isCountryName(locName) {
  if (!locName) return false
  const lower = locName.toLowerCase().trim()
  return Object.keys(capitals).some(c => c.toLowerCase() === lower)
}

function makeNewsDot(color, size = 7) {
  const ring = Math.round(size * 3.2)
  return L.divIcon({
    className: '',
    iconSize: [ring, ring],
    iconAnchor: [ring / 2, ring / 2],
    html: `<div style="position:relative;width:${ring}px;height:${ring}px;pointer-events:none;">
      <div class="news-pulse-ring" style="position:absolute;top:0;left:0;width:100%;height:100%;border-radius:50%;background:${color};"></div>
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:${size}px;height:${size}px;border-radius:50%;background:${color};cursor:pointer;"></div>
    </div>`,
  })
}

function computeDisruption(feature, articles, hoursWindow) {
  const URGENCY_W = { high: 1.0, medium: 0.6, low: 0.3 }
  const cutoff = Date.now() - hoursWindow * 3600000
  const keywords = feature.properties?.keywords || []
  if (!keywords.length) return { pct: 0, articles: [] }

  const matches = articles.filter(a => {
    if (!a.published_at || new Date(a.published_at).getTime() < cutoff) return false
    return a.locations_affected?.some(loc =>
      keywords.some(kw => loc.name?.toLowerCase().includes(kw.toLowerCase()))
    )
  })
  if (!matches.length) return { pct: 0, articles: [] }

  const score = matches.reduce((sum, a) => {
    const ageHours = (Date.now() - new Date(a.published_at).getTime()) / 3600000
    const recency = Math.max(0, 1 - ageHours / hoursWindow)
    return sum + (a.conviction || 5) * (URGENCY_W[a.urgency] || 0.3) * recency
  }, 0)

  return { pct: Math.min(100, Math.round(score * 5)), articles: matches }
}

function disruptionColor(pct) {
  if (pct >= 50) return _gc.routeHigh
  if (pct >= 20) return _gc.routeElevated
  if (pct > 0) return _gc.routeNormal
  return _gc.routeNoSignal
}

function infraColor(ftype) {
  if (ENERGY_TYPES.has(ftype)) return _gc.energy
  if (MINING_TYPES.has(ftype)) return _gc.mining
  if (AG_TYPES.has(ftype)) return _gc.agriculture
  return '#888888'
}

function timeAgo(isoStr) {
  if (!isoStr) return 'never'
  const diff = Date.now() - new Date(isoStr).getTime()
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor(diff / 3600000)
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  return 'just now'
}

// ─── Map sub-layers ───────────────────────────────────────────────────────────

function RoutesLayer({ articles, hoursWindow, onSelect }) {
  return tradeRoutes.features.map(feature => {
    const { pct, articles: matchArticles } = computeDisruption(feature, articles, hoursWindow)
    const color = disruptionColor(pct)
    const coords = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng])
    return (
      <Polyline
        key={feature.properties.id}
        positions={coords}
        pathOptions={{ color, weight: 3, opacity: 0.85, dashArray: pct > 0 ? '8 6' : null }}
        eventHandlers={{
          click: () => onSelect({ type: 'route', feature, disruption: { pct, articles: matchArticles } }),
        }}
      />
    )
  })
}

function getMatchingArticles(feature, articles) {
  const result = []
  for (const article of articles) {
    const locs = article.locations_affected || []
    let byInstrument = false
    let byIndustry = false
    let matchedBy = []

    for (const inst of (article.instruments_affected || [])) {
      const key = inst.toUpperCase().replace(/[^A-Z]/g, '')
      const types = INSTRUMENT_TO_TYPES[key] || []
      if (types.includes(feature.feature_type)) { byInstrument = true; matchedBy.push(inst) }
    }
    for (const ind of (article.industries_affected || [])) {
      const types = INDUSTRY_TO_TYPES[ind.toLowerCase()] || []
      if (types.includes(feature.feature_type)) { byIndustry = true; matchedBy.push(ind) }
    }

    if (!byInstrument && !byIndustry) continue

    if (byInstrument) {
      result.push({ article, matchedBy })
      continue
    }
    // Industry-only: require at least one location within radius
    const nearby = locs.some(loc => {
      const coords = getLocationCoords(loc.name, loc.lat, loc.lng)
      if (!coords) return false
      return haversineKm(coords[0], coords[1], feature.lat, feature.lng) < INDUSTRY_ONLY_RADIUS_KM
    })
    if (nearby) result.push({ article, matchedBy })
  }
  return result
}

function InfraLayer({ infrastructure, influenceMin, layers, articles, onSelect }) {
  const filtered = useMemo(
    () => infrastructure.filter(f => f.influence >= influenceMin),
    [infrastructure, influenceMin]
  )

  return filtered.map(f => {
    const show =
      (layers.energy && ENERGY_TYPES.has(f.feature_type)) ||
      (layers.mining && MINING_TYPES.has(f.feature_type)) ||
      (layers.agriculture && AG_TYPES.has(f.feature_type))
    if (!show) return null

    const color = infraColor(f.feature_type)
    const r = 3 + Math.round(f.influence * 0.5)

    return (
      <CircleMarker
        key={f.id}
        center={[f.lat, f.lng]}
        radius={r}
        pathOptions={{ color, fillColor: color, fillOpacity: 0.6, weight: 1, opacity: 0.9 }}
        eventHandlers={{
          click: () => onSelect({ type: 'infra', feature: f, matchingArticles: getMatchingArticles(f, articles) }),
        }}
      />
    )
  })
}

// Great-circle distance in km between two lat/lng points
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Industry-only matches (no specific traded instrument) are constrained to infra within this radius.
// Instrument matches (USOIL, BRENT, GOLD, etc.) have global reach — those truly move global markets.
const INDUSTRY_ONLY_RADIUS_KM = 3500

// ArcsLayer: draws only from the clicked news dot's location.
// Two arc types per article:
//   1. fromCoords → matching infrastructure (instrument/industry based, geo-filtered)
//   2. fromCoords → other locations mentioned in the article (geo-connection lines)
function ArcsLayer({ articles, fromCoords, fromName, infrastructure, influenceMin, onSelect }) {
  const arcs = useMemo(() => {
    if (!fromCoords || !articles.length) return []
    const eligibleInfra = infrastructure.filter(f => f.influence >= influenceMin)
    const infraArcs = []
    const geoArcs = []
    const seenGeo = new Set()

    for (const article of articles) {
      if (!article.locations_affected?.length) continue

      const instrumentMatchTypes = new Set()
      const instrumentMatchedBy = []
      for (const inst of (article.instruments_affected || [])) {
        const key = inst.toUpperCase().replace(/[^A-Z]/g, '')
        const types = INSTRUMENT_TO_TYPES[key] || []
        if (types.length) { types.forEach(t => instrumentMatchTypes.add(t)); instrumentMatchedBy.push(inst) }
      }
      const industryMatchTypes = new Set()
      const industryMatchedBy = []
      for (const ind of (article.industries_affected || [])) {
        const types = INDUSTRY_TO_TYPES[ind.toLowerCase()] || []
        if (types.length) { types.forEach(t => industryMatchTypes.add(t)); industryMatchedBy.push(ind) }
      }
      const allMatchedBy = [...instrumentMatchedBy, ...industryMatchedBy]
      const color = article.direction === 'bullish' ? _gc.bullish
        : article.direction === 'bearish' ? _gc.bearish
        : _gc.neutral
      const weight = 0.5 + (article.conviction || 5) * 0.08
      const opacity = 0.3 + (article.conviction || 5) * 0.04

      // Type 1: fromCoords → matching infrastructure
      if (instrumentMatchTypes.size || industryMatchTypes.size) {
        const matchingInfra = eligibleInfra
          .filter(f => {
            const byInstrument = instrumentMatchTypes.has(f.feature_type)
            const byIndustry = industryMatchTypes.has(f.feature_type)
            if (!byInstrument && !byIndustry) return false
            if (byInstrument) return true
            return haversineKm(fromCoords[0], fromCoords[1], f.lat, f.lng) < INDUSTRY_ONLY_RADIUS_KM
          })
          .sort((a, b) => b.influence - a.influence)
          .slice(0, 5)

        for (const infra of matchingInfra) {
          const linkTypes = allMatchedBy
            .filter(m => {
              const key = m.toUpperCase().replace(/[^A-Z]/g, '')
              const types = INSTRUMENT_TO_TYPES[key] || INDUSTRY_TO_TYPES[m.toLowerCase()] || []
              return types.includes(infra.feature_type)
            })
            .slice(0, 3)
          infraArcs.push({
            path: bezierArcPath(fromCoords, [infra.lat, infra.lng]),
            color, weight, opacity,
            key: `infra-${article.id}-${infra.id}`,
            kind: 'infra',
            article, infraName: infra.name, infraType: infra.feature_type,
            fromLoc: fromName, linkTypes,
          })
        }
      }

      // Type 2: fromCoords → other mentioned locations (geo-connection lines)
      for (const loc of article.locations_affected) {
        const locCoords = getLocationCoords(loc.name, loc.lat, loc.lng)
        if (!locCoords) continue
        // Skip if it's essentially the same spot as the clicked dot
        if (haversineKm(fromCoords[0], fromCoords[1], locCoords[0], locCoords[1]) < 200) continue
        const geoKey = `${locCoords[0].toFixed(1)},${locCoords[1].toFixed(1)}`
        if (seenGeo.has(geoKey)) continue
        seenGeo.add(geoKey)
        geoArcs.push({
          path: bezierArcPath(fromCoords, locCoords),
          color: _gc.arcGeo,
          weight: 1,
          opacity: 0.5,
          key: `geo-${article.id}-${loc.name}`,
          kind: 'geo',
          article,
          toLocName: loc.name,
          fromLoc: fromName,
          linkTypes: [],
        })
      }
    }

    return [...geoArcs, ...infraArcs] // geo behind, infra on top
  }, [articles, fromCoords, fromName, infrastructure, influenceMin])

  return arcs.map(arc => {
    if (arc.kind === 'geo') {
      return (
        <React.Fragment key={arc.key}>
          <Polyline
            positions={arc.path}
            pathOptions={{ color: arc.color, weight: arc.weight, opacity: arc.opacity, dashArray: '3 6', interactive: false }}
          />
          <Polyline
            positions={arc.path}
            pathOptions={{ color: arc.color, weight: 14, opacity: 0 }}
          >
            <Tooltip sticky direction="top" offset={[0, -4]} className="arc-tooltip" pane="tooltipPane">
              <div style={{ fontFamily: 'monospace', fontSize: 10, background: '#0a0a0f', border: '1px solid #1e1e2e', padding: '4px 8px', borderRadius: 3, color: '#7788aa' }}>
                {arc.fromLoc} → {arc.toLocName}
                <div style={{ color: '#445566', marginTop: 2 }}>location mentioned in article</div>
              </div>
            </Tooltip>
          </Polyline>
        </React.Fragment>
      )
    }

    const dirLabel = arc.article.direction?.toUpperCase() || 'NEUTRAL'
    const conv = arc.article.conviction || '?'
    const ttTitle = arc.article.title?.length > 60 ? arc.article.title.slice(0, 60) + '…' : arc.article.title
    const via = arc.linkTypes.length ? arc.linkTypes.join(', ') : arc.infraType?.replace(/_/g, ' ')

    return (
      <React.Fragment key={arc.key}>
        <Polyline
          positions={arc.path}
          pathOptions={{ color: arc.color, weight: arc.weight, opacity: arc.opacity, dashArray: '5 8', interactive: false }}
        />
        <Polyline
          positions={arc.path}
          pathOptions={{ color: arc.color, weight: 14, opacity: 0 }}
          eventHandlers={{
            click: () => onSelect({ type: 'arc', article: arc.article, infraName: arc.infraName, fromLoc: arc.fromLoc, linkTypes: arc.linkTypes }),
          }}
        >
          <Tooltip sticky direction="top" offset={[0, -4]} className="arc-tooltip" pane="tooltipPane">
            <div style={{ fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace", fontSize: 10, lineHeight: 1.5, maxWidth: 240, background: '#0a0a0f', border: '1px solid #1e1e2e', padding: '5px 8px', borderRadius: 3, color: '#e8e8f0' }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 3 }}>
                <span style={{ color: arc.color, fontWeight: 700 }}>{dirLabel}</span>
                <span style={{ color: '#666677' }}>C{conv}</span>
                <span style={{ color: '#444455', marginLeft: 'auto' }}>{arc.fromLoc} → {arc.infraName}</span>
              </div>
              <div style={{ color: '#aaaacc' }}>{ttTitle}</div>
              {via && <div style={{ color: '#555566', marginTop: 2 }}>via {via}</div>}
            </div>
          </Tooltip>
        </Polyline>
      </React.Fragment>
    )
  })
}

function NewsLayer({ articles, onSelect }) {
  const dots = useMemo(() => {
    const placed = {}
    const result = []

    for (const article of articles) {
      if (!article.locations_affected?.length) continue
      for (const loc of article.locations_affected) {
        const coords = getLocationCoords(loc.name, loc.lat, loc.lng)
        if (!coords) continue

        const key = `${Math.round(coords[0] * 4) / 4},${Math.round(coords[1] * 4) / 4}`
        if (!placed[key]) {
          placed[key] = {
            coords,
            articles: [],
            direction: article.direction,
            locName: loc.name,
          }
          result.push(placed[key])
        }
        placed[key].articles.push(article)

        // Use highest conviction direction
        if ((article.conviction || 0) > ((placed[key].topConv) || 0)) {
          placed[key].direction = article.direction
          placed[key].topConv = article.conviction
        }
      }
    }

    return result
  }, [articles])

  return dots.map((dot, i) => {
    const color = dot.direction === 'bullish' ? _gc.bullish
      : dot.direction === 'bearish' ? _gc.bearish
      : _gc.neutral
    const icon = makeNewsDot(color, 6)

    return (
      <Marker
        key={i}
        position={dot.coords}
        icon={icon}
        eventHandlers={{
          click: () => onSelect({ type: 'news', location: dot.locName, coords: dot.coords, articles: dot.articles }),
        }}
      />
    )
  })
}

function CountryHighlightLayer({ worldGeoJSON, articles }) {
  const mentionedCountries = useMemo(() => {
    const set = new Set()
    for (const article of articles) {
      for (const loc of (article.locations_affected || [])) {
        if (isCountryName(loc.name)) set.add(loc.name.toLowerCase())
      }
    }
    return set
  }, [articles])

  if (!mentionedCountries.size || !worldGeoJSON) return null

  const filtered = {
    ...worldGeoJSON,
    features: worldGeoJSON.features.filter(f => {
      const name = (f.properties?.name || '').toLowerCase()
      return mentionedCountries.has(name) ||
        [...mentionedCountries].some(c =>
          (c.length > 4 && name.includes(c)) || (name.length > 4 && c.includes(name))
        )
    }),
  }

  if (!filtered.features.length) return null

  return (
    <GeoJSON
      key={[...mentionedCountries].join(',')}
      data={filtered}
      style={() => ({
        fillColor: '#4444ff',
        fillOpacity: 0.06,
        color: '#5555cc',
        weight: 1,
        opacity: 0.35,
      })}
    />
  )
}

// ─── Vessel, Flight, Zone layers ─────────────────────────────────────────────

function zoneColor(zone_type) {
  if (zone_type === 'maritime_conflict' || zone_type === 'airspace_closed') return _gc.zoneConflict
  if (zone_type === 'maritime_risk') return _gc.zoneRisk
  if (zone_type === 'airspace_restricted') return _gc.zoneRestricted
  if (zone_type === 'sanctioned') return _gc.zoneSanctioned
  return '#888888'
}

function ZonesLayer({ zones, onSelect }) {
  if (!zones?.length) return null
  return zones.map(f => {
    const p = f.properties
    const color = zoneColor(p.zone_type)
    return (
      <GeoJSON
        key={p.id}
        data={f}
        style={{
          color, weight: 1, opacity: 0.6,
          fillColor: color, fillOpacity: p.risk_level === 'high' ? 0.12 : 0.06,
          dashArray: '4 4',
        }}
        eventHandlers={{
          click: () => onSelect({ type: 'zone', zone: p }),
        }}
      >
        <Tooltip sticky direction="top" className="arc-tooltip" pane="tooltipPane">
          <div style={{ fontFamily: 'monospace', fontSize: 10, background: '#0a0a0f', border: `1px solid ${color}`, padding: '4px 8px', borderRadius: 3, color }}>
            {p.name}
            <div style={{ color: '#888899', marginTop: 2 }}>{p.zone_type?.replace(/_/g, ' ').toUpperCase()}</div>
          </div>
        </Tooltip>
      </GeoJSON>
    )
  })
}

function makeArrowIcon(color, heading, size = 10) {
  const h = heading ?? 0
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;transform:rotate(${h}deg);display:flex;align-items:center;justify-content:center;font-size:${size}px;line-height:1;color:${color};filter:drop-shadow(0 0 3px ${color}88)">▲</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function VesselsLayer({ vessels, onSelect }) {
  if (!vessels?.length) return null
  return vessels.map(v => {
    if (!v.lat || !v.lng) return null
    const icon = makeArrowIcon(_gc.vessel, v.heading, 9)
    return (
      <Marker key={v.mmsi} position={[v.lat, v.lng]} icon={icon}
        eventHandlers={{ click: () => onSelect({ type: 'vessel', vessel: v }) }}
      >
        <Tooltip sticky direction="top" className="arc-tooltip" pane="tooltipPane">
          <div style={{ fontFamily: 'monospace', fontSize: 10, background: '#0a0a0f', border: `1px solid ${_gc.vessel}`, padding: '4px 8px', borderRadius: 3, color: _gc.vessel }}>
            {v.name || v.mmsi}
            {v.speed_kts != null && <span style={{ color: '#666677', marginLeft: 6 }}>{v.speed_kts}kts</span>}
            {v.destination && <div style={{ color: '#666677', marginTop: 2 }}>→ {v.destination}</div>}
          </div>
        </Tooltip>
      </Marker>
    )
  })
}

function FlightsLayer({ flights, onSelect }) {
  if (!flights?.length) return null
  return flights.map(f => {
    if (!f.lat || !f.lng) return null
    const icon = makeArrowIcon(_gc.flight, f.heading, 9)
    return (
      <Marker key={f.icao24} position={[f.lat, f.lng]} icon={icon}
        eventHandlers={{ click: () => onSelect({ type: 'flight', flight: f }) }}
      >
        <Tooltip sticky direction="top" className="arc-tooltip" pane="tooltipPane">
          <div style={{ fontFamily: 'monospace', fontSize: 10, background: '#0a0a0f', border: `1px solid ${_gc.flight}`, padding: '4px 8px', borderRadius: 3, color: _gc.flight }}>
            {f.callsign}
            <span style={{ color: '#666677', marginLeft: 6 }}>{f.country}</span>
            {f.altitude_ft != null && <div style={{ color: '#666677', marginTop: 2 }}>{f.altitude_ft.toLocaleString()}ft · {f.speed_kts}kts</div>}
          </div>
        </Tooltip>
      </Marker>
    )
  })
}

// ─── Layer control panel ──────────────────────────────────────────────────────

const LAYER_DEFS = [
  { key: 'news', label: 'NEWS', color: '#00ff88' },
  { key: 'arcs', label: 'ARCS', color: '#ffffff' },
  { key: 'routes', label: 'ROUTES', color: '#3d5a73' },
  { key: 'energy', label: 'ENERGY', color: '#ff9500' },
  { key: 'mining', label: 'MINING', color: '#5b8db8' },
  { key: 'agriculture', label: 'AGRI', color: '#a8c240' },
  { key: 'vessels', label: 'VESSELS', color: '#00aaff' },
  { key: 'flights', label: 'FLIGHTS', color: '#ffcc00' },
  { key: 'zones', label: 'ZONES', color: '#ff3b3b' },
]

function LayerControls({
  layers, onToggle, hoursWindow, onHoursChange,
  influenceMin, onInfluenceChange,
  infraCount, lastUpdated, refreshing, refreshStatus, onRefresh,
}) {
  const S = {
    panel: {
      position: 'absolute', top: 16, left: 16, zIndex: 1000,
      background: 'rgba(0,0,0,0.88)', border: '1px solid #1e1e2e',
      borderRadius: 4, padding: '10px 12px', minWidth: 185,
      fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace",
      fontSize: 11, color: '#e8e8f0', userSelect: 'none',
    },
    row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 },
    dot: (color, on) => ({
      width: 8, height: 8, borderRadius: '50%',
      background: on ? color : '#333', border: `1px solid ${color}`,
      flexShrink: 0,
    }),
    toggle: (on) => ({
      width: 28, height: 14, borderRadius: 7,
      background: on ? '#1e3a1e' : '#1a1a24',
      border: `1px solid ${on ? '#00ff40' : '#333'}`,
      position: 'relative', cursor: 'pointer', flexShrink: 0,
    }),
    knob: (on) => ({
      position: 'absolute', top: 2, left: on ? 14 : 2,
      width: 10, height: 10, borderRadius: '50%',
      background: on ? '#00ff40' : '#555',
      transition: 'left 0.15s',
    }),
    divider: { borderTop: '1px solid #1e1e2e', margin: '8px 0' },
    muted: { color: '#555566', fontSize: 10, marginBottom: 3 },
  }

  return (
    <div style={S.panel}>
      {LAYER_DEFS.map(({ key, label, color }) => (
        <div key={key} style={S.row}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}
            onClick={() => onToggle(key)}
          >
            <div style={S.dot(color, layers[key])} />
            <span style={{ color: layers[key] ? '#e8e8f0' : '#555566' }}>{label}</span>
          </div>
          <div style={S.toggle(layers[key])} onClick={() => onToggle(key)}>
            <div style={S.knob(layers[key])} />
          </div>
        </div>
      ))}

      <div style={S.divider} />

      <div style={{ marginBottom: 8 }}>
        <div style={S.muted}>INFLUENCE ≥ {influenceMin}</div>
        <input
          type="range" min={1} max={10} value={influenceMin}
          onChange={e => onInfluenceChange(Number(e.target.value))}
          style={{ width: '100%', accentColor: '#00ff40', cursor: 'pointer' }}
        />
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={S.muted}>TIME WINDOW</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[[24, '24H'], [48, '48H'], [72, '3D'], [168, '7D']].map(([h, lbl]) => (
            <button
              key={h}
              onClick={() => onHoursChange(h)}
              style={{
                flex: 1, padding: '2px 0', fontSize: 10, cursor: 'pointer',
                background: hoursWindow === h ? '#1a2e1a' : 'transparent',
                border: `1px solid ${hoursWindow === h ? '#00ff40' : '#333'}`,
                color: hoursWindow === h ? '#00ff40' : '#555566',
                borderRadius: 2,
              }}
            >{lbl}</button>
          ))}
        </div>
      </div>

      <div style={S.divider} />

      <div style={{ ...S.muted, color: '#444455' }}>
        <div>{infraCount.toLocaleString()} SITES</div>
        <div style={{ marginTop: 2 }}>UPDATED {lastUpdated ? timeAgo(lastUpdated).toUpperCase() : 'NEVER'}</div>
      </div>

      {refreshStatus && (
        <div style={{ marginTop: 5, fontSize: 9, color: '#666677', lineHeight: 1.4 }}>
          {refreshStatus}
        </div>
      )}

      <button
        onClick={onRefresh}
        disabled={refreshing}
        style={{
          width: '100%', marginTop: 6, padding: '4px 0', fontSize: 10,
          cursor: refreshing ? 'default' : 'pointer',
          background: 'transparent', border: '1px solid #1e1e2e',
          color: refreshing ? '#444455' : '#666677', borderRadius: 2,
        }}
      >
        {refreshing ? 'REFRESHING...' : 'REFRESH DATA'}
      </button>
    </div>
  )
}

// ─── Arc panel ────────────────────────────────────────────────────────────────

function ArcPanel({ selected, S }) {
  const { article: a, infraName, fromLoc, linkTypes } = selected
  const dirColor = a.direction === 'bullish' ? _gc.bullish
    : a.direction === 'bearish' ? _gc.bearish
    : _gc.neutral
  const hrsAgo = Math.round((Date.now() - new Date(a.published_at).getTime()) / 3600000)

  return (
    <>
      <div style={S.section}>
        <div style={S.sectionTitle}>WHY THIS CONNECTION</div>
        <div style={{ color: '#888899', lineHeight: 1.7 }}>
          News event in <span style={{ color: '#e8e8f0' }}>{fromLoc}</span> is routed to{' '}
          <span style={{ color: '#e8e8f0' }}>{infraName}</span> because the article
          affects{' '}
          <span style={{ color: dirColor }}>
            {linkTypes.length ? linkTypes.join(', ') : 'this commodity type'}
          </span>.
        </div>
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>ARTICLE</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 6, alignItems: 'center' }}>
          <span style={S.tag(dirColor)}>{(a.direction || 'neutral').toUpperCase()}</span>
          {a.conviction && <span style={S.tag('#666677')}>CONVICTION {a.conviction}/10</span>}
          {a.urgency === 'high' && <span style={S.tag('#ff6b00')}>URGENT</span>}
          <span style={{ color: '#333344', fontSize: 9, marginLeft: 'auto' }}>{hrsAgo}H AGO</span>
        </div>
        <div style={{ color: '#e8e8f0', lineHeight: 1.5, marginBottom: 8 }}>{a.title}</div>
        {a.reasoning && (
          <div style={{ color: '#666677', lineHeight: 1.6, fontSize: 10 }}>{a.reasoning}</div>
        )}
      </div>

      {a.instruments_affected?.length > 0 && (
        <div style={S.section}>
          <div style={S.sectionTitle}>INSTRUMENTS AFFECTED</div>
          <div>{a.instruments_affected.map(t => <span key={t} style={S.tag('#5b8db8')}>{t}</span>)}</div>
        </div>
      )}

      {a.industries_affected?.length > 0 && (
        <div style={S.section}>
          <div style={S.sectionTitle}>INDUSTRIES AFFECTED</div>
          <div>{a.industries_affected.map(t => <span key={t} style={S.tag('#7777aa')}>{t}</span>)}</div>
        </div>
      )}

      {a.locations_affected?.length > 0 && (
        <div style={S.section}>
          <div style={S.sectionTitle}>ALL LOCATIONS IN THIS ARTICLE</div>
          <div>{a.locations_affected.map(l => <span key={l.name} style={S.tag('#444455')}>{l.name}</span>)}</div>
        </div>
      )}
    </>
  )
}

function ZonePanel({ selected, S }) {
  const z = selected.zone
  const color = zoneColor(z.zone_type)
  const riskColors = { high: _gc.bearish, elevated: _gc.zoneRisk, low: _gc.neutral }
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <span style={S.tag(color)}>{z.zone_type?.replace(/_/g, ' ').toUpperCase()}</span>
        <span style={{ ...S.tag(riskColors[z.risk_level] || '#888888'), marginLeft: 6 }}>
          {z.risk_level?.toUpperCase()} RISK
        </span>
      </div>
      <div style={S.section}>
        <div style={{ color: '#ccccdd', lineHeight: 1.7 }}>{z.detail}</div>
      </div>
      {z.active_since && (
        <div style={S.section}>
          <div style={S.sectionTitle}>ACTIVE SINCE</div>
          <div style={S.value}>{z.active_since}</div>
        </div>
      )}
    </>
  )
}

function VesselPanel({ selected, S }) {
  const v = selected.vessel
  const typeLabel = v.ship_type ? `Type ${v.ship_type}` : 'Unknown type'
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <span style={S.tag(_gc.vessel)}>VESSEL</span>
        {v.flag && <span style={{ ...S.tag('#333344'), marginLeft: 6 }}>{v.flag}</span>}
      </div>
      <div style={S.section}>
        <div style={S.sectionTitle}>DETAILS</div>
        {v.mmsi && <div style={S.row}><span style={S.muted}>MMSI</span><span style={S.value}>{v.mmsi}</span></div>}
        {v.callsign && <div style={S.row}><span style={S.muted}>Callsign</span><span style={S.value}>{v.callsign}</span></div>}
        <div style={S.row}><span style={S.muted}>Type</span><span style={S.value}>{typeLabel}</span></div>
        {v.speed_kts != null && <div style={S.row}><span style={S.muted}>Speed</span><span style={S.value}>{v.speed_kts} kts</span></div>}
        {v.heading != null && <div style={S.row}><span style={S.muted}>Heading</span><span style={S.value}>{v.heading}°</span></div>}
        {v.destination && <div style={S.row}><span style={S.muted}>Destination</span><span style={S.value}>{v.destination}</span></div>}
      </div>
      <div style={S.section}>
        <div style={S.sectionTitle}>POSITION</div>
        <div style={{ color: '#444455', fontFeatureSettings: '"tnum"' }}>
          {v.lat?.toFixed(4)}°, {v.lng?.toFixed(4)}°
        </div>
      </div>
    </>
  )
}

function FlightPanel({ selected, S }) {
  const f = selected.flight
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <span style={S.tag(_gc.flight)}>CARGO FLIGHT</span>
        {f.country && <span style={{ ...S.tag('#333344'), marginLeft: 6 }}>{f.country}</span>}
      </div>
      <div style={S.section}>
        <div style={S.sectionTitle}>DETAILS</div>
        {f.icao24 && <div style={S.row}><span style={S.muted}>ICAO24</span><span style={S.value}>{f.icao24}</span></div>}
        {f.altitude_ft != null && <div style={S.row}><span style={S.muted}>Altitude</span><span style={S.value}>{f.altitude_ft.toLocaleString()} ft</span></div>}
        {f.speed_kts != null && <div style={S.row}><span style={S.muted}>Speed</span><span style={S.value}>{f.speed_kts} kts</span></div>}
        {f.heading != null && <div style={S.row}><span style={S.muted}>Heading</span><span style={S.value}>{f.heading}°</span></div>}
      </div>
      <div style={S.section}>
        <div style={S.sectionTitle}>POSITION</div>
        <div style={{ color: '#444455', fontFeatureSettings: '"tnum"' }}>
          {f.lat?.toFixed(4)}°, {f.lng?.toFixed(4)}°
        </div>
      </div>
    </>
  )
}

// ─── Info panels ──────────────────────────────────────────────────────────────

function InfoPanel({ selected, onClose }) {
  const S = {
    panel: {
      width: 360, height: '100%', background: '#070709',
      borderLeft: '1px solid #1e1e2e', overflowY: 'auto',
      fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace",
      fontSize: 11, color: '#e8e8f0', flexShrink: 0,
    },
    empty: {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', color: '#222233', fontSize: 12, textAlign: 'center',
      padding: 24, lineHeight: 1.8,
    },
    header: {
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      padding: '10px 14px', borderBottom: '1px solid #1e1e2e',
      background: '#0a0a0f', gap: 8,
    },
    title: { fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', lineHeight: 1.4 },
    close: {
      cursor: 'pointer', color: '#555566', fontSize: 18,
      lineHeight: 1, background: 'none', border: 'none', padding: 0, flexShrink: 0,
    },
    body: { padding: '12px 14px' },
    section: { marginBottom: 14 },
    sectionTitle: {
      color: '#444455', fontSize: 9, letterSpacing: '0.1em',
      marginBottom: 6, textTransform: 'uppercase',
    },
    row: { display: 'flex', justifyContent: 'space-between', marginBottom: 3, gap: 8 },
    value: { color: '#e8e8f0', textAlign: 'right' },
    muted: { color: '#888899', flexShrink: 0 },
    tag: (color) => ({
      display: 'inline-block', padding: '1px 5px', borderRadius: 2,
      background: color + '22', border: `1px solid ${color}55`, color,
      fontSize: 9, letterSpacing: '0.05em', marginRight: 3, marginBottom: 3,
    }),
    bar: (pct, color) => ({
      height: 3, borderRadius: 2, marginTop: 4,
      background: `linear-gradient(to right, ${color} ${pct}%, #1e1e2e ${pct}%)`,
    }),
    articleRow: {
      paddingBottom: 8, marginBottom: 6, borderBottom: '1px solid #0d0d14',
    },
  }

  if (!selected) {
    return (
      <div style={S.panel}>
        <div style={S.empty}>
          CLICK A ROUTE, SITE,<br />OR NEWS DOT TO<br />SEE DETAILS
        </div>
      </div>
    )
  }

  const title = selected.type === 'route' ? selected.feature.properties.name
    : selected.type === 'infra' ? selected.feature.name
    : selected.type === 'arc' ? `${selected.fromLoc} → ${selected.infraName}`
    : selected.type === 'zone' ? selected.zone.name
    : selected.type === 'vessel' ? (selected.vessel.name || selected.vessel.mmsi)
    : selected.type === 'flight' ? selected.flight.callsign
    : selected.location

  return (
    <div style={S.panel}>
      <div style={S.header}>
        <span style={S.title}>{title}</span>
        <button style={S.close} onClick={onClose}>×</button>
      </div>
      <div style={S.body}>
        {selected.type === 'route' && <RoutePanel selected={selected} S={S} />}
        {selected.type === 'infra' && <InfraPanel selected={selected} S={S} />}
        {selected.type === 'news' && <NewsDotPanel selected={selected} S={S} />}
        {selected.type === 'arc' && <ArcPanel selected={selected} S={S} />}
        {selected.type === 'zone' && <ZonePanel selected={selected} S={S} />}
        {selected.type === 'vessel' && <VesselPanel selected={selected} S={S} />}
        {selected.type === 'flight' && <FlightPanel selected={selected} S={S} />}
      </div>
    </div>
  )
}

function RoutePanel({ selected, S }) {
  const { feature, disruption } = selected
  const p = feature.properties
  const color = disruptionColor(disruption.pct)
  const riskLabel = disruption.pct >= 50 ? 'HIGH RISK'
    : disruption.pct >= 20 ? 'ELEVATED'
    : disruption.pct > 0 ? 'ACTIVE SIGNAL'
    : 'NO SIGNAL'

  return (
    <>
      <div style={S.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ color, fontWeight: 700 }}>{riskLabel}</span>
          <span style={{ color, fontSize: 14, fontWeight: 700 }}>{disruption.pct}%</span>
        </div>
        <div style={S.bar(disruption.pct, color)} />
        {p.current_risk_baseline && (
          <div style={{ color: '#555566', fontSize: 10, marginTop: 4 }}>
            BASELINE: {p.current_risk_baseline.toUpperCase()}
          </div>
        )}
      </div>

      {(p.daily_oil_mbd || p.daily_lng_pct || p.vessels_per_year) && (
        <div style={S.section}>
          <div style={S.sectionTitle}>THROUGHPUT</div>
          {p.daily_oil_mbd && <div style={S.row}><span style={S.muted}>Daily oil</span><span style={S.value}>{p.daily_oil_mbd}M bbl/day</span></div>}
          {p.daily_lng_pct && <div style={S.row}><span style={S.muted}>Global LNG share</span><span style={S.value}>~{p.daily_lng_pct}%</span></div>}
          {p.vessels_per_year && <div style={S.row}><span style={S.muted}>Vessels/year</span><span style={S.value}>{p.vessels_per_year.toLocaleString()}</span></div>}
          {p.width_km && <div style={S.row}><span style={S.muted}>Width</span><span style={S.value}>{p.width_km} km</span></div>}
        </div>
      )}

      {p.dependent_nations?.length > 0 && (
        <div style={S.section}>
          <div style={S.sectionTitle}>DEPENDENT NATIONS</div>
          {p.dependent_nations.map(n => (
            <div key={n.country} style={S.row}>
              <span style={S.muted}>{n.country}</span>
              <span style={S.value}>{n.pct}% via {n.commodity}</span>
            </div>
          ))}
        </div>
      )}

      {p.price_impact && (
        <div style={S.section}>
          <div style={S.sectionTitle}>PRICE IMPACT IF DISRUPTED</div>
          <div style={{ color: _gc.bearish, lineHeight: 1.6, fontSize: 11 }}>{p.price_impact}</div>
        </div>
      )}

      {p.alternative_route && (
        <div style={S.section}>
          <div style={S.sectionTitle}>ALTERNATIVE ROUTE</div>
          <div style={{ color: '#777788', lineHeight: 1.6 }}>{p.alternative_route}</div>
        </div>
      )}

      {p.strategic_notes && (
        <div style={S.section}>
          <div style={S.sectionTitle}>STRATEGIC NOTES</div>
          <div style={{ color: '#666677', lineHeight: 1.7 }}>{p.strategic_notes}</div>
        </div>
      )}

      {p.historical_disruptions?.length > 0 && (
        <div style={S.section}>
          <div style={S.sectionTitle}>HISTORICAL DISRUPTIONS</div>
          {p.historical_disruptions.map((d, i) => (
            <div key={i} style={{ ...S.row, alignItems: 'flex-start' }}>
              <span style={{ ...S.muted, flexShrink: 0 }}>{d.year}</span>
              <span style={{ ...S.value, textAlign: 'right', fontSize: 10, color: '#666677' }}>{d.event}</span>
            </div>
          ))}
        </div>
      )}

      {disruption.articles.length > 0 && (
        <div style={S.section}>
          <div style={S.sectionTitle}>CURRENT SIGNALS — {disruption.articles.length}</div>
          {disruption.articles.slice(0, 5).map(a => (
            <ArticleRow key={a.id} article={a} S={S} />
          ))}
        </div>
      )}
    </>
  )
}

function InfraPanel({ selected, S }) {
  const f = selected.feature
  const matches = selected.matchingArticles || []
  const color = infraColor(f.feature_type)
  const typeLabel = f.feature_type?.replace(/_/g, ' ').toUpperCase() || 'FACILITY'

  const bullish = matches.filter(m => m.article.direction === 'bullish').length
  const bearish = matches.filter(m => m.article.direction === 'bearish').length
  const avgConv = matches.length
    ? Math.round(matches.reduce((s, m) => s + (m.article.conviction || 5), 0) / matches.length * 10) / 10
    : null

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <span style={S.tag(color)}>{typeLabel}</span>
        {matches.length > 0 && (
          <span style={{ ...S.tag(bullish >= bearish ? _gc.bullish : _gc.bearish), marginLeft: 6 }}>
            {matches.length} SIGNAL{matches.length !== 1 ? 'S' : ''}
          </span>
        )}
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>DETAILS</div>
        {f.country && <div style={S.row}><span style={S.muted}>Country</span><span style={S.value}>{f.country}</span></div>}
        {f.operator && <div style={S.row}><span style={S.muted}>Operator</span><span style={{ ...S.value, fontSize: 10 }}>{f.operator}</span></div>}
        {f.capacity_note && <div style={S.row}><span style={S.muted}>Capacity</span><span style={S.value}>{f.capacity_note}</span></div>}
        <div style={S.row}>
          <span style={S.muted}>Influence</span>
          <span style={{ color, fontWeight: 700 }}>{f.influence}/10</span>
        </div>
      </div>

      {matches.length > 0 ? (
        <div style={S.section}>
          <div style={S.sectionTitle}>WHY THIS SITE</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {bullish > 0 && <span style={S.tag(_gc.bullish)}>↑ {bullish} bullish</span>}
            {bearish > 0 && <span style={S.tag(_gc.bearish)}>↓ {bearish} bearish</span>}
            {avgConv !== null && <span style={S.tag('#555566')}>avg C{avgConv}</span>}
          </div>
          {matches.slice(0, 8).map(({ article: a, matchedBy }, i) => {
            const dirColor = a.direction === 'bullish' ? _gc.bullish
              : a.direction === 'bearish' ? _gc.bearish : _gc.neutral
            const hrsAgo = Math.round((Date.now() - new Date(a.published_at).getTime()) / 3600000)
            return (
              <div key={i} style={{ ...S.articleRow, borderLeft: `2px solid ${dirColor}`, paddingLeft: 8 }}>
                <div style={{ display: 'flex', gap: 4, marginBottom: 3, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={S.tag(dirColor)}>{(a.direction || 'neutral').toUpperCase()}</span>
                  {a.conviction && <span style={S.tag('#555566')}>C{a.conviction}</span>}
                  {matchedBy.slice(0, 3).map(m => (
                    <span key={m} style={{ ...S.tag('#334455'), color: '#88aacc' }}>{m}</span>
                  ))}
                  <span style={{ color: '#333344', fontSize: 9, marginLeft: 'auto' }}>{hrsAgo}h ago</span>
                </div>
                <div style={{ color: '#ccccdd', fontSize: 11, lineHeight: 1.4 }}>{a.title}</div>
                {a.reasoning && (
                  <div style={{ color: '#444455', fontSize: 10, lineHeight: 1.4, marginTop: 3 }}>{a.reasoning}</div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div style={S.section}>
          <div style={S.sectionTitle}>WHY THIS SITE</div>
          <div style={{ color: '#333344', fontSize: 11 }}>No recent articles targeting this site.</div>
        </div>
      )}

      <div style={S.section}>
        <div style={S.sectionTitle}>COORDINATES</div>
        <div style={{ color: '#444455', fontFeatureSettings: '"tnum"' }}>
          {f.lat?.toFixed(4)}°, {f.lng?.toFixed(4)}°
        </div>
      </div>
    </>
  )
}

function NewsDotPanel({ selected, S }) {
  const { location, articles } = selected
  const bullish = articles.filter(a => a.direction === 'bullish').length
  const bearish = articles.filter(a => a.direction === 'bearish').length
  const avgConv = articles.length
    ? Math.round(articles.reduce((s, a) => s + (a.conviction || 5), 0) / articles.length * 10) / 10
    : 0

  return (
    <>
      <div style={S.section}>
        <div style={S.row}><span style={S.muted}>Articles</span><span style={S.value}>{articles.length}</span></div>
        <div style={S.row}><span style={S.muted}>Avg conviction</span><span style={S.value}>{avgConv}/10</span></div>
        <div style={{ marginTop: 4 }}>
          {bullish > 0 && <span style={S.tag(_gc.bullish)}>↑ {bullish} BULLISH</span>}
          {bearish > 0 && <span style={S.tag(_gc.bearish)}>↓ {bearish} BEARISH</span>}
          {bullish === 0 && bearish === 0 && <span style={S.tag(_gc.neutral)}>NEUTRAL</span>}
        </div>
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>ARTICLES</div>
        {articles.slice(0, 10).map(a => (
          <ArticleRow key={a.id} article={a} S={S} />
        ))}
      </div>
    </>
  )
}

function ArticleRow({ article: a, S }) {
  const dirColor = a.direction === 'bullish' ? _gc.bullish
    : a.direction === 'bearish' ? _gc.bearish
    : _gc.neutral
  const hrsAgo = Math.round((Date.now() - new Date(a.published_at).getTime()) / 3600000)

  return (
    <div style={S.articleRow}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 4, alignItems: 'center' }}>
        <span style={S.tag(dirColor)}>{(a.direction || 'neutral').toUpperCase()}</span>
        {a.conviction && <span style={S.tag('#666677')}>C{a.conviction}</span>}
        {a.urgency === 'high' && <span style={S.tag('#ff6b00')}>URGENT</span>}
        <span style={{ color: '#333344', fontSize: 9, marginLeft: 'auto' }}>{hrsAgo}H</span>
      </div>
      <div style={{ lineHeight: 1.45, color: '#ccccdd', fontSize: 11 }}>{a.title}</div>
      {a.reasoning && (
        <div style={{ color: '#444455', lineHeight: 1.5, marginTop: 3, fontSize: 10 }}>{a.reasoning}</div>
      )}
      {a.instruments_affected?.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {a.instruments_affected.slice(0, 5).map(t => (
            <span key={t} style={S.tag('#5b8db8')}>{t}</span>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Globe() {
  const [settings, setSettings] = useState(null)
  const [articles, setArticles] = useState([])
  const [infrastructure, setInfrastructure] = useState([])
  const [worldGeoJSON, setWorldGeoJSON] = useState(null)
  const [layers, setLayers] = useState({
    news: true, arcs: true, routes: true,
    energy: true, mining: true, agriculture: true,
    vessels: true, flights: true, zones: true,
  })
  const [hoursWindow, setHoursWindow] = useState(48)
  const [influenceMin, setInfluenceMin] = useState(3)
  const [selected, setSelected] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshStatus, setRefreshStatus] = useState('')
  const [flights, setFlights] = useState([])
  const [vessels, setVessels] = useState([])
  const [zones, setZones] = useState([])
  const pollRef = useRef(null)

  // Sync colors each render
  _gc.bullish = settings?.color_globe_news_bullish || '#00ff88'
  _gc.bearish = settings?.color_globe_news_bearish || '#ff3b3b'
  _gc.neutral = settings?.color_globe_news_neutral || '#8888aa'
  _gc.routeNoSignal = settings?.color_globe_route_no_signal || '#3d5a73'
  _gc.routeNormal = settings?.color_globe_route_normal || '#00ff88'
  _gc.routeElevated = settings?.color_globe_route_elevated || '#ff6b00'
  _gc.routeHigh = settings?.color_globe_route_high_risk || '#ff3b3b'
  _gc.arcGeo = settings?.color_globe_arc_geo || '#445566'
  _gc.vessel = settings?.color_globe_vessel || '#00aaff'
  _gc.flight = settings?.color_globe_flight || '#ffcc00'
  _gc.zoneConflict = settings?.color_globe_zone_conflict || '#ff3b3b'
  _gc.zoneRisk = settings?.color_globe_zone_risk || '#ff6b00'
  _gc.zoneRestricted = settings?.color_globe_zone_restricted || '#aa44ff'
  _gc.zoneSanctioned = settings?.color_globe_zone_sanctioned || '#ff44aa'

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {})
    api.globeData({ since_hours: 168 }).then(setArticles).catch(() => {})
    api.getInfrastructure({ min_influence: 1 }).then(data => {
      setInfrastructure(data)
      if (data.length > 0) {
        const latest = data.reduce((a, b) => (a.fetched_at > b.fetched_at ? a : b), data[0])
        setLastUpdated(latest.fetched_at)
      }
    }).catch(() => {})
    fetch('https://cdn.jsdelivr.net/gh/johan/world.geo.json@34c96bba18/countries.geo.json')
      .then(r => r.json())
      .then(setWorldGeoJSON)
      .catch(() => {})

    // Load static zones
    import('../data/restricted_zones.json').then(m => setZones(m.default?.features || [])).catch(() => {})

    // Live tracking — initial fetch + 60s poll
    const fetchTracking = () => {
      api.getFlights().then(d => setFlights(d.flights || [])).catch(() => {})
      api.getVessels().then(d => setVessels(d.vessels || [])).catch(() => {})
    }
    fetchTracking()
    const trackingInterval = setInterval(fetchTracking, 60000)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      clearInterval(trackingInterval)
    }
  }, [])

  const filteredArticles = useMemo(() => {
    const cutoff = Date.now() - hoursWindow * 3600000
    return articles.filter(a => new Date(a.published_at).getTime() >= cutoff)
  }, [articles, hoursWindow])

  const handleRefresh = useCallback(async () => {
    if (pollRef.current) clearInterval(pollRef.current)
    setRefreshing(true)
    setRefreshStatus('Querying OpenStreetMap...')
    const prevCount = infrastructure.length

    try {
      await api.refreshInfrastructure()
    } catch {
      setRefreshing(false)
      setRefreshStatus('Refresh request failed')
      return
    }

    let elapsed = 0
    pollRef.current = setInterval(async () => {
      elapsed += 30
      try {
        const data = await api.getInfrastructure({ min_influence: 1 })
        const newCount = data.length
        setRefreshStatus(`Fetching... ${newCount} sites found (${elapsed}s)`)
        if (newCount > prevCount || elapsed >= 600) {
          setInfrastructure(data)
          if (data.length > 0) {
            const latest = data.reduce((a, b) => (a.fetched_at > b.fetched_at ? a : b), data[0])
            setLastUpdated(latest.fetched_at)
          }
          clearInterval(pollRef.current)
          pollRef.current = null
          setRefreshing(false)
          setRefreshStatus(`Done — ${newCount} sites loaded`)
          setTimeout(() => setRefreshStatus(''), 5000)
        }
      } catch {
        // keep polling
      }
    }, 30000)
  }, [infrastructure.length])

  const toggleLayer = useCallback((key) => {
    setLayers(prev => ({ ...prev, [key]: !prev[key] }))
  }, [])

  return (
    <div style={{ display: 'flex', height: '100%', background: '#000', overflow: 'hidden' }}>
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        <MapContainer
          center={[25, 30]}
          zoom={3}
          style={{ width: '100%', height: '100%', background: '#000005' }}
          zoomControl={false}
          attributionControl={false}
          minZoom={2}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            maxZoom={18}
            subdomains="abcd"
          />

          {layers.news && worldGeoJSON && (
            <CountryHighlightLayer
              worldGeoJSON={worldGeoJSON}
              articles={filteredArticles}
            />
          )}

          {layers.routes && (
            <RoutesLayer
              articles={filteredArticles}
              hoursWindow={hoursWindow}
              onSelect={setSelected}
            />
          )}

          <InfraLayer
            infrastructure={infrastructure}
            influenceMin={influenceMin}
            layers={layers}
            articles={filteredArticles}
            onSelect={setSelected}
          />

          {layers.arcs && selected?.type === 'news' && (
            <ArcsLayer
              articles={selected.articles}
              fromCoords={selected.coords}
              fromName={selected.location}
              infrastructure={infrastructure}
              onSelect={setSelected}
              influenceMin={influenceMin}
            />
          )}

          {layers.news && (
            <NewsLayer
              articles={filteredArticles}
              onSelect={setSelected}
            />
          )}

          {layers.zones && <ZonesLayer zones={zones} onSelect={setSelected} />}
          {layers.vessels && <VesselsLayer vessels={vessels} onSelect={setSelected} />}
          {layers.flights && <FlightsLayer flights={flights} onSelect={setSelected} />}
        </MapContainer>

        <LayerControls
          layers={layers}
          onToggle={toggleLayer}
          hoursWindow={hoursWindow}
          onHoursChange={setHoursWindow}
          influenceMin={influenceMin}
          onInfluenceChange={setInfluenceMin}
          infraCount={infrastructure.length}
          lastUpdated={lastUpdated}
          refreshing={refreshing}
          refreshStatus={refreshStatus}
          onRefresh={handleRefresh}
        />
      </div>

      <InfoPanel selected={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
