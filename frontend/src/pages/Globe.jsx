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
  energy: ['oil_field', 'refinery', 'gas_plant', 'lng_terminal', 'nuclear', 'energy_facility'],
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

function InfraLayer({ infrastructure, influenceMin, layers, onSelect }) {
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
          click: () => onSelect({ type: 'infra', feature: f }),
        }}
      />
    )
  })
}

function ArcsLayer({ articles, infrastructure, influenceMin }) {
  const arcs = useMemo(() => {
    const eligibleInfra = infrastructure.filter(f => f.influence >= influenceMin)
    const result = []

    for (const article of articles.slice(0, 100)) {
      if (!article.locations_affected?.length) continue

      const matchTypes = new Set()
      for (const inst of (article.instruments_affected || [])) {
        const key = inst.toUpperCase().replace(/[^A-Z]/g, '')
        const types = INSTRUMENT_TO_TYPES[key] || []
        types.forEach(t => matchTypes.add(t))
      }
      for (const ind of (article.industries_affected || [])) {
        const types = INDUSTRY_TO_TYPES[ind.toLowerCase()] || []
        types.forEach(t => matchTypes.add(t))
      }
      if (!matchTypes.size) continue

      const matchingInfra = eligibleInfra
        .filter(f => matchTypes.has(f.feature_type))
        .sort((a, b) => b.influence - a.influence)
        .slice(0, 4)

      if (!matchingInfra.length) continue

      const color = article.direction === 'bullish' ? _gc.bullish
        : article.direction === 'bearish' ? _gc.bearish
        : _gc.neutral

      const weight = 0.5 + (article.conviction || 5) * 0.08
      const opacity = 0.2 + (article.conviction || 5) * 0.03

      for (const loc of article.locations_affected.slice(0, 2)) {
        const coords = getLocationCoords(loc.name, loc.lat, loc.lng)
        if (!coords) continue

        for (const infra of matchingInfra) {
          const path = bezierArcPath(coords, [infra.lat, infra.lng])
          result.push({ path, color, weight, opacity, key: `${article.id}-${infra.id}-${loc.name}` })
        }
      }

      if (result.length >= 200) break
    }

    return result
  }, [articles, infrastructure, influenceMin])

  return arcs.map(arc => (
    <Polyline
      key={arc.key}
      positions={arc.path}
      pathOptions={{
        color: arc.color,
        weight: arc.weight,
        opacity: arc.opacity,
        dashArray: '5 8',
      }}
    />
  ))
}

function NewsLayer({ articles, onSelect }) {
  const dots = useMemo(() => {
    const placed = {}
    const result = []

    for (const article of articles) {
      if (!article.locations_affected?.length) continue
      for (const loc of article.locations_affected.slice(0, 2)) {
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
          click: () => onSelect({ type: 'news', location: dot.locName, articles: dot.articles }),
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

// ─── Layer control panel ──────────────────────────────────────────────────────

const LAYER_DEFS = [
  { key: 'news', label: 'NEWS', color: '#00ff88' },
  { key: 'arcs', label: 'ARCS', color: '#ffffff' },
  { key: 'routes', label: 'ROUTES', color: '#3d5a73' },
  { key: 'energy', label: 'ENERGY', color: '#ff9500' },
  { key: 'mining', label: 'MINING', color: '#5b8db8' },
  { key: 'agriculture', label: 'AGRI', color: '#a8c240' },
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
  const color = infraColor(f.feature_type)
  const typeLabel = f.feature_type?.replace(/_/g, ' ').toUpperCase() || 'FACILITY'

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <span style={S.tag(color)}>{typeLabel}</span>
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
  })
  const [hoursWindow, setHoursWindow] = useState(48)
  const [influenceMin, setInfluenceMin] = useState(3)
  const [selected, setSelected] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshStatus, setRefreshStatus] = useState('')
  const pollRef = useRef(null)

  // Sync colors each render
  _gc.bullish = settings?.color_globe_news_bullish || '#00ff88'
  _gc.bearish = settings?.color_globe_news_bearish || '#ff3b3b'
  _gc.neutral = settings?.color_globe_news_neutral || '#8888aa'
  _gc.routeNoSignal = settings?.color_globe_route_no_signal || '#3d5a73'
  _gc.routeNormal = settings?.color_globe_route_normal || '#00ff88'
  _gc.routeElevated = settings?.color_globe_route_elevated || '#ff6b00'
  _gc.routeHigh = settings?.color_globe_route_high_risk || '#ff3b3b'

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
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
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
            onSelect={setSelected}
          />

          {layers.arcs && (
            <ArcsLayer
              articles={filteredArticles}
              infrastructure={infrastructure}
              influenceMin={influenceMin}
            />
          )}

          {layers.news && (
            <NewsLayer
              articles={filteredArticles}
              onSelect={setSelected}
            />
          )}
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
