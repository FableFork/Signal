import 'leaflet/dist/leaflet.css'
import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import { api } from '../lib/api'
import { useApp } from '../App'
import tradeRoutes from '../data/trade_routes.json'
import energyData from '../data/energy.json'
import miningData from '../data/mining_agriculture.json'

// ─── Constants ────────────────────────────────────────────────────────────────

const C = {
  bullish: '#00ff88',
  bearish: '#ff3b3b',
  neutral: '#555566',
  amber: '#ff6b00',
}

const TIME_RANGES = { '6H': 6, '24H': 24, '48H': 48, '7D': 168 }
const URGENCY_W = { high: 1.0, medium: 0.6, low: 0.3 }
const PANEL_W = 380

const COMMODITY_COLORS = {
  copper: '#b87333', copper_gold: '#c5a028', gold: '#ffd700',
  lithium: '#7ec8e3', rare_earths: '#b39ddb', cobalt: '#42a5f5',
  wheat_corn_sunflower: '#f9a825', soybeans_corn_sugar: '#66bb6a',
  soybeans_wheat_corn_beef: '#81c784', wheat_barley_sunflower: '#ffe082',
  wheat_rice: '#ffe082', fishmeal_fish_oil: '#4dd0e1',
  potash_fertilizer: '#a5d6a7', potash_urea_ammonia: '#c8e6c9',
  containers_iron_ore_copper: '#78909c',
}
const TYPE_COLORS = {
  oil_field: '#ff8c00', refinery: '#ffa500', gas_field: '#81d4fa',
  lng_terminal: '#29b6f6', oil_terminal: '#ffb74d', pipeline: '#ff7043',
  nuclear: '#ef5350', mine: '#a0a0a0', agriculture: '#f9a825', port: '#4dd0e1',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dirColor(dir) {
  if (dir === 'bullish') return C.bullish
  if (dir === 'bearish') return C.bearish
  return C.neutral
}

function disruptionColor(pct) {
  if (pct === 0) return '#333344'
  if (pct < 20) return C.bullish
  if (pct < 50) return C.amber
  return C.bearish
}

function disruptionLabel(pct) {
  if (pct === 0) return 'NO SIGNAL'
  if (pct < 20) return 'NORMAL'
  if (pct < 50) return 'ELEVATED'
  return 'HIGH RISK'
}

function timeAgo(dateStr) {
  const h = Math.floor((Date.now() - new Date(dateStr).getTime()) / 3600000)
  if (h < 1) return `${Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000)}m ago`
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function computeDisruption(feature, articles, hoursWindow) {
  const cutoff = Date.now() - hoursWindow * 3600000
  const keywords = (feature.properties.keywords || []).map(k => k.toLowerCase())
  const matches = articles.filter(a => {
    if (new Date(a.published_at).getTime() < cutoff) return false
    return (a.locations_affected || []).some(loc =>
      keywords.some(kw => loc.name.toLowerCase().includes(kw))
    )
  })
  if (!matches.length) return { pct: 0, articles: [], avgConviction: 0 }
  const score = matches.reduce((sum, a) => {
    const conviction = a.conviction || 5
    const urgencyW = URGENCY_W[a.urgency] || 0.3
    const ageHours = (Date.now() - new Date(a.published_at).getTime()) / 3600000
    return sum + conviction * urgencyW * Math.max(0, 1 - ageHours / hoursWindow)
  }, 0)
  const pct = Math.min(100, Math.round(score * 5))
  const avgConviction = matches.reduce((s, a) => s + (a.conviction || 5), 0) / matches.length
  return { pct, articles: matches, avgConviction: Math.round(avgConviction * 10) / 10 }
}

function resColor(f) {
  return COMMODITY_COLORS[f.properties.commodity] || TYPE_COLORS[f.properties.type] || '#aaaaaa'
}

function makeIcon(color, shape) {
  const size = 9
  let inner
  if (shape === 'mine') {
    inner = `<div style="width:${size}px;height:${size}px;background:${color};transform:rotate(45deg) scale(0.85);border:1px solid rgba(0,0,0,0.5);box-shadow:0 0 3px ${color}44;"></div>`
  } else if (shape === 'agriculture') {
    inner = `<div style="width:${size}px;height:${size}px;background:${color};border:1px solid rgba(0,0,0,0.5);box-shadow:0 0 3px ${color}44;"></div>`
  } else {
    inner = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:1px solid rgba(0,0,0,0.5);box-shadow:0 0 4px ${color}66;"></div>`
  }
  return L.divIcon({
    html: `<div style="display:flex;align-items:center;justify-content:center;width:${size+2}px;height:${size+2}px;">${inner}</div>`,
    className: '',
    iconSize: [size + 2, size + 2],
    iconAnchor: [(size + 2) / 2, (size + 2) / 2],
  })
}

// ─── Map Layer Components ─────────────────────────────────────────────────────

function NewsLayer({ points, onPointClick }) {
  return points.map((pt, i) => {
    const color = dirColor(pt.direction)
    const radius = Math.max(5, Math.min(16, 4 + pt.conviction * 1.2))
    return (
      <CircleMarker
        key={i}
        center={[pt.lat, pt.lng]}
        radius={radius}
        pathOptions={{ fillColor: color, fillOpacity: 0.75, color, weight: 1, opacity: 0.9 }}
        eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); onPointClick(pt) } }}
      >
        <Tooltip direction="top" offset={[0, -6]} opacity={0.95}>
          <div style={{ fontFamily: 'monospace', fontSize: 11 }}>
            <b>{pt.name}</b><br />
            {pt.count} article{pt.count > 1 ? 's' : ''} · {pt.direction} · avg {pt.conviction.toFixed(1)}
          </div>
        </Tooltip>
      </CircleMarker>
    )
  })
}

function RoutesLayer({ disruptions, onRouteClick, hoveredId, setHoveredId }) {
  return tradeRoutes.features.map((feature) => {
    const id = feature.properties.id
    const d = disruptions[id] || { pct: 0 }
    const color = disruptionColor(d.pct)
    const isHovered = hoveredId === id
    const positions = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng])
    return (
      <Polyline
        key={id}
        positions={positions}
        pathOptions={{
          color,
          weight: isHovered ? 5 : 3,
          opacity: isHovered ? 1 : 0.85,
          dashArray: d.pct >= 50 ? '6 4' : d.pct >= 20 ? '10 5' : null,
        }}
        eventHandlers={{
          click: (e) => { L.DomEvent.stopPropagation(e); onRouteClick(feature, d) },
          mouseover: () => setHoveredId(id),
          mouseout: () => setHoveredId(null),
        }}
      >
        <Tooltip direction="top" opacity={0.95} sticky>
          <div style={{ fontFamily: 'monospace', fontSize: 11 }}>
            <b>{feature.properties.name}</b><br />
            <span style={{ color }}>{disruptionLabel(d.pct)}</span>
            {d.pct > 0 ? ` · ${d.pct}%` : ''}
          </div>
        </Tooltip>
      </Polyline>
    )
  })
}

function ResourceLayer({ features, disruptions, onResClick }) {
  return features.map((feature, i) => {
    const { id, type } = feature.properties
    const [lng, lat] = feature.geometry.coordinates
    const color = resColor(feature)
    const d = disruptions[id] || { pct: 0 }
    const shape = type === 'mine' ? 'mine' : (type === 'agriculture' || type === 'port') ? 'agriculture' : 'energy'
    const icon = makeIcon(color, shape)
    return (
      <Marker
        key={id || i}
        position={[lat, lng]}
        icon={icon}
        eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); onResClick(feature, d) } }}
      >
        <Tooltip direction="top" offset={[0, -5]} opacity={0.95}>
          <div style={{ fontFamily: 'monospace', fontSize: 11 }}>
            <b>{feature.properties.name}</b><br />
            {feature.properties.country} · {feature.properties.type?.replace(/_/g, ' ')}
            {d.pct > 0 && <><br /><span style={{ color: disruptionColor(d.pct) }}>{disruptionLabel(d.pct)} {d.pct}%</span></>}
          </div>
        </Tooltip>
      </Marker>
    )
  })
}

// ─── Info Panels ─────────────────────────────────────────────────────────────

const S = {
  panel: {
    width: PANEL_W, height: '100%', background: 'var(--bg-secondary)',
    borderLeft: '1px solid var(--border)', overflowY: 'auto',
    flexShrink: 0, fontFamily: 'var(--font)',
  },
  sectionHdr: {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.15em',
    color: 'var(--text-secondary)', marginBottom: 6, marginTop: 16,
  },
  divider: { borderTop: '1px solid var(--border)', margin: '12px 0' },
}

function StatusDot({ pct }) {
  return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: disruptionColor(pct), marginRight: 6 }} />
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontSize: 10, color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', maxWidth: '65%' }}>{value}</span>
    </div>
  )
}

function Tag({ label, color }) {
  return (
    <span style={{ fontSize: 9, padding: '2px 6px', border: `1px solid ${color}44`, color, letterSpacing: '0.08em', fontWeight: 700 }}>
      {label}
    </span>
  )
}

function SignalArticles({ articles, avgConviction }) {
  if (!articles.length) return (
    <>
      <div style={S.divider} />
      <div style={S.sectionHdr}>CURRENT SIGNALS</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>No recent coverage in selected window</div>
    </>
  )
  return (
    <>
      <div style={S.divider} />
      <div style={S.sectionHdr}>CURRENT SIGNALS</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
        {articles.length} article{articles.length > 1 ? 's' : ''} · avg conviction {avgConviction}
      </div>
      {articles.slice(0, 5).map((a, i) => (
        <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 3 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: dirColor(a.direction) }}>{(a.direction || 'neutral').toUpperCase()}</span>
            <span style={{ fontSize: 9, color: 'var(--text-secondary)', marginLeft: 'auto' }}>{timeAgo(a.published_at)}</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-primary)', lineHeight: 1.5 }}>{a.title}</div>
        </div>
      ))}
    </>
  )
}

function RoutePanel({ feature, disruption }) {
  const p = feature.properties
  const { pct, articles: ma = [], avgConviction } = disruption
  return (
    <div style={{ padding: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.08em', marginBottom: 4 }}>
        {p.name.toUpperCase()}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <StatusDot pct={pct} />
        <span style={{ fontSize: 11, fontWeight: 700, color: disruptionColor(pct), letterSpacing: '0.1em' }}>{disruptionLabel(pct)}</span>
        {pct > 0 && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>· {pct}% disruption signal</span>}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{p.region}</div>
      <div style={S.divider} />
      <div style={S.sectionHdr}>FLOW</div>
      {p.daily_oil_mbd && <Row label="Oil" value={`${p.daily_oil_mbd}M bbl/day`} />}
      {p.daily_lng_pct && <Row label="LNG" value={`~${p.daily_lng_pct}% of global LNG trade`} />}
      {p.container_ships_daily && <Row label="Container ships" value={`~${p.container_ships_daily}/day`} />}
      {p.trade_pct_global && <Row label="Global trade share" value={`~${p.trade_pct_global}%`} />}
      {p.vessels_per_year && <Row label="Vessels/year" value={p.vessels_per_year.toLocaleString()} />}
      {p.commodities && <Row label="Commodities" value={p.commodities.join(', ')} />}
      {p.dependent_nations?.length > 0 && <>
        <div style={S.divider} />
        <div style={S.sectionHdr}>DEPENDENT NATIONS</div>
        {p.dependent_nations.map((n, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid var(--border)', fontSize: 11 }}>
            <span style={{ color: 'var(--text-primary)' }}>{n.country}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{n.pct}%{n.commodity ? ` · ${n.commodity}` : ''}</span>
          </div>
        ))}
      </>}
      <div style={S.divider} />
      <div style={S.sectionHdr}>IF DISRUPTED → PRICE IMPACT</div>
      <div style={{ fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.6 }}>{p.price_impact}</div>
      {p.alternative_route && <>
        <div style={{ ...S.sectionHdr, marginTop: 12 }}>ALTERNATIVE ROUTE</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{p.alternative_route}</div>
      </>}
      {p.historical_disruptions?.length > 0 && <>
        <div style={S.divider} />
        <div style={S.sectionHdr}>HISTORICAL DISRUPTIONS</div>
        {p.historical_disruptions.map((h, i) => (
          <div key={i} style={{ marginBottom: 5 }}>
            <span style={{ fontSize: 10, color: C.amber, fontWeight: 700 }}>{h.year}</span>
            <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 8 }}>{h.event}</span>
          </div>
        ))}
      </>}
      {p.strategic_notes && <>
        <div style={S.divider} />
        <div style={S.sectionHdr}>STRATEGIC NOTES</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{p.strategic_notes}</div>
      </>}
      <SignalArticles articles={ma} avgConviction={avgConviction} />
    </div>
  )
}

function ResourcePanel({ feature, disruption }) {
  const p = feature.properties
  const { pct, articles: ma = [], avgConviction } = disruption
  const statusColor = p.operational_status === 'operational' ? C.bullish
    : ['constrained', 'partially_operational', 'volatile', 'underperforming', 'ramping'].includes(p.operational_status) ? C.amber
    : ['shutdown_standby', 'expired_contract', 'severely_disrupted'].includes(p.operational_status) ? C.bearish
    : C.neutral
  return (
    <div style={{ padding: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.08em', marginBottom: 4 }}>
        {p.name.toUpperCase()}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
        {p.country}{p.operator ? ` · ${p.operator}` : ''}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
        <Tag label={p.type?.replace(/_/g, ' ')} color="var(--text-secondary)" />
        {p.sanctions && <Tag label="SANCTIONED" color={C.bearish} />}
        <Tag label={p.operational_status?.replace(/_/g, ' ').toUpperCase()} color={statusColor} />
      </div>
      {pct > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <StatusDot pct={pct} />
          <span style={{ fontSize: 11, fontWeight: 700, color: disruptionColor(pct) }}>{disruptionLabel(pct)} · {pct}% signal</span>
        </div>
      )}
      <div style={S.divider} />
      <div style={S.sectionHdr}>CAPACITY & SIGNIFICANCE</div>
      {p.capacity && <Row label="Capacity" value={p.capacity} />}
      {p.significance && <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 4 }}>{p.significance}</div>}
      {p.reserves && <Row label="Reserves" value={p.reserves} />}
      {p.price_impact && <>
        <div style={S.divider} />
        <div style={S.sectionHdr}>IF DISRUPTED → PRICE IMPACT</div>
        <div style={{ fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.6 }}>{p.price_impact}</div>
      </>}
      {p.alternative_supply && <>
        <div style={{ ...S.sectionHdr, marginTop: 12 }}>ALTERNATIVE SUPPLY</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{p.alternative_supply}</div>
      </>}
      {p.primary_buyers && <>
        <div style={S.divider} />
        <div style={S.sectionHdr}>PRIMARY BUYERS</div>
        <div style={{ fontSize: 11, color: 'var(--text-primary)' }}>{p.primary_buyers.join(' · ')}</div>
      </>}
      {p.export_destinations && <>
        <div style={S.divider} />
        <div style={S.sectionHdr}>EXPORT DESTINATIONS</div>
        <div style={{ fontSize: 11, color: 'var(--text-primary)' }}>{p.export_destinations.join(' · ')}</div>
      </>}
      {p.risk_factors && <>
        <div style={S.divider} />
        <div style={S.sectionHdr}>RISK FACTORS</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{p.risk_factors}</div>
      </>}
      <SignalArticles articles={ma} avgConviction={avgConviction} />
    </div>
  )
}

function NewsClusterPanel({ point, onArticleClick }) {
  return (
    <div style={{ padding: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.08em', marginBottom: 4 }}>
        {point.name.toUpperCase()}
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        {Object.entries(point.directions).map(([dir, cnt]) => cnt > 0 && (
          <span key={dir} style={{ fontSize: 10, color: dirColor(dir), fontWeight: 700 }}>{cnt} {dir}</span>
        ))}
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 'auto' }}>avg {point.conviction.toFixed(1)}</span>
      </div>
      <div style={S.divider} />
      {point.articles.map((a, i) => (
        <div key={i} onClick={() => onArticleClick(a)}
          style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
        >
          <div style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: dirColor(a.direction), letterSpacing: '0.08em' }}>
              {(a.direction || 'neutral').toUpperCase()}
            </span>
            {a.conviction && <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}>C:{a.conviction}</span>}
            <span style={{ fontSize: 9, color: 'var(--text-secondary)', marginLeft: 'auto' }}>{timeAgo(a.published_at)}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.5 }}>{a.title}</div>
          {a.instruments_affected?.length > 0 && (
            <div style={{ display: 'flex', gap: 4, marginTop: 5, flexWrap: 'wrap' }}>
              {a.instruments_affected.slice(0, 5).map((inst, j) => (
                <span key={j} style={{
                  fontSize: 9, padding: '1px 5px',
                  background: `${dirColor(a.direction)}22`, color: dirColor(a.direction),
                  borderRadius: 3, fontWeight: 700,
                }}>{inst}</span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function DefaultPanel({ routeDisruptions, totalArticles }) {
  const activeRoutes = tradeRoutes.features
    .map(f => ({ name: f.properties.short || f.properties.name, pct: routeDisruptions[f.properties.id]?.pct || 0 }))
    .sort((a, b) => b.pct - a.pct)
  return (
    <div style={{ padding: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.15em', color: 'var(--accent)', marginBottom: 16 }}>
        INTELLIGENCE OVERVIEW
      </div>
      <Row label="Articles w/ location data" value={totalArticles} />
      <div style={S.divider} />
      <div style={S.sectionHdr}>ROUTE STATUS</div>
      {activeRoutes.map(r => (
        <div key={r.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 11, color: 'var(--text-primary)' }}>{r.name}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <StatusDot pct={r.pct} />
            <span style={{ fontSize: 10, color: disruptionColor(r.pct), fontWeight: 700 }}>
              {disruptionLabel(r.pct)}{r.pct > 0 ? ` ${r.pct}%` : ''}
            </span>
          </div>
        </div>
      ))}
      <div style={S.divider} />
      <div style={S.sectionHdr}>LEGEND — ROUTES</div>
      {[['#00ff88', 'Normal (&lt;20% signal)'], [C.amber, 'Elevated (20–50%)'], [C.bearish, 'High risk (&gt;50%)'], ['#333344', 'No signal']].map(([color, label]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
          <div style={{ width: 22, height: 3, background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: 'var(--text-secondary)' }} dangerouslySetInnerHTML={{ __html: label }} />
        </div>
      ))}
      <div style={S.divider} />
      <div style={S.sectionHdr}>LEGEND — MARKERS</div>
      {[
        ['circle', '#ff8c00', 'Energy (circle)'],
        ['diamond', '#b87333', 'Mining (diamond)'],
        ['square', '#f9a825', 'Agriculture / Port (square)'],
        ['circle', C.bullish, 'News — bullish'],
        ['circle', C.bearish, 'News — bearish'],
      ].map(([shape, color, label]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
          {shape === 'diamond'
            ? <div style={{ width: 8, height: 8, background: color, transform: 'rotate(45deg)', flexShrink: 0 }} />
            : shape === 'square'
            ? <div style={{ width: 8, height: 8, background: color, flexShrink: 0 }} />
            : <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
          }
          <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{label}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Layer Control ────────────────────────────────────────────────────────────

const LAYER_DEFS = [
  { id: 'news', label: 'NEWS', color: C.bullish },
  { id: 'routes', label: 'ROUTES', color: '#29b6f6' },
  { id: 'energy', label: 'ENERGY', color: '#ff8c00' },
  { id: 'mining', label: 'MINING', color: '#b87333' },
  { id: 'agriculture', label: 'AGRI / PORTS', color: '#f9a825' },
]

function LayerControl({ layers, toggle, timeRange, setTimeRange }) {
  return (
    <div style={{
      position: 'absolute', top: 14, left: 14, zIndex: 1000,
      background: 'rgba(0,0,0,0.82)', border: '1px solid var(--border)',
      padding: '10px 12px', minWidth: 170, backdropFilter: 'blur(4px)',
    }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.15em', color: 'var(--text-secondary)', marginBottom: 8 }}>LAYERS</div>
      {LAYER_DEFS.map(l => (
        <div key={l.id} onClick={() => toggle(l.id)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer', opacity: layers[l.id] ? 1 : 0.35, transition: 'opacity 0.15s' }}
        >
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: layers[l.id] ? l.color : 'var(--border)', border: `1px solid ${l.color}66`, transition: 'background 0.15s' }} />
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-primary)' }}>{l.label}</span>
        </div>
      ))}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10 }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.15em', color: 'var(--text-secondary)', marginBottom: 6 }}>TIME WINDOW</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {Object.keys(TIME_RANGES).map(t => (
            <button key={t} onClick={() => setTimeRange(t)} style={{
              fontSize: 9, padding: '2px 7px', fontWeight: 700,
              background: timeRange === t ? 'var(--accent)' : 'transparent',
              color: timeRange === t ? 'var(--bg-primary)' : 'var(--text-secondary)',
              border: `1px solid ${timeRange === t ? 'var(--accent)' : 'var(--border)'}`,
              cursor: 'pointer', letterSpacing: '0.05em', fontFamily: 'inherit',
            }}>{t}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const CARTO_TILE = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const CARTO_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'

export default function Globe() {
  const { setSelectedArticle, setTab } = useApp()
  const [articles, setArticles] = useState([])
  const [loading, setLoading] = useState(true)
  const [timeRange, setTimeRange] = useState(() => localStorage.getItem('globe_time') || '24H')
  const [layers, setLayers] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('globe_layers'))
      if (saved) return saved
    } catch {}
    return { news: true, routes: true, energy: true, mining: true, agriculture: true }
  })
  const [selected, setSelected] = useState(null)
  const [hoveredRoute, setHoveredRoute] = useState(null)

  useEffect(() => { localStorage.setItem('globe_time', timeRange) }, [timeRange])
  useEffect(() => { localStorage.setItem('globe_layers', JSON.stringify(layers)) }, [layers])

  useEffect(() => {
    setLoading(true)
    api.globeData({ since_hours: TIME_RANGES['7D'] })
      .then(setArticles).catch(() => setArticles([]))
      .finally(() => setLoading(false))
  }, [])

  const toggleLayer = useCallback((id) => setLayers(prev => ({ ...prev, [id]: !prev[id] })), [])
  const hoursWindow = TIME_RANGES[timeRange]

  const filteredArticles = useMemo(() => {
    const cutoff = Date.now() - hoursWindow * 3600000
    return articles.filter(a => new Date(a.published_at).getTime() >= cutoff)
  }, [articles, hoursWindow])

  const newsPoints = useMemo(() => {
    const map = {}
    filteredArticles.forEach(a => {
      (a.locations_affected || []).forEach(loc => {
        if (!loc.lat || !loc.lng) return
        const key = `${Math.round(loc.lat * 10)},${Math.round(loc.lng * 10)}`
        if (!map[key]) map[key] = { lat: loc.lat, lng: loc.lng, name: loc.name, articles: [], directions: { bullish: 0, bearish: 0, neutral: 0 } }
        map[key].articles.push(a)
        const dir = a.direction || 'neutral'
        map[key].directions[dir] = (map[key].directions[dir] || 0) + 1
      })
    })
    return Object.values(map).map(pt => {
      const dominant = Object.entries(pt.directions).sort((a, b) => b[1] - a[1])[0][0]
      const avgConv = pt.articles.reduce((s, a) => s + (a.conviction || 5), 0) / pt.articles.length
      return { ...pt, direction: dominant, conviction: avgConv, count: pt.articles.length }
    })
  }, [filteredArticles])

  const allFeatures = useMemo(() => [
    ...tradeRoutes.features,
    ...energyData.features,
    ...miningData.features,
  ], [])

  const disruptions = useMemo(() => {
    const result = {}
    allFeatures.forEach(f => {
      if (f.properties.id) result[f.properties.id] = computeDisruption(f, filteredArticles, hoursWindow)
    })
    return result
  }, [allFeatures, filteredArticles, hoursWindow])

  const routeDisruptions = useMemo(() => {
    const r = {}
    tradeRoutes.features.forEach(f => { r[f.properties.id] = disruptions[f.properties.id] || { pct: 0, articles: [], avgConviction: 0 } })
    return r
  }, [disruptions])

  const handleArticleClick = useCallback((article) => {
    setSelectedArticle(article)
    setTab('dashboard')
  }, [setSelectedArticle, setTab])

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 42px)', background: '#000' }}>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <MapContainer
          center={[20, 15]}
          zoom={2}
          minZoom={2}
          maxZoom={12}
          style={{ width: '100%', height: '100%' }}
          zoomControl={false}
          attributionControl={false}
          maxBounds={[[-85, -200], [85, 200]]}
          maxBoundsViscosity={0.8}
        >
          <TileLayer url={CARTO_TILE} attribution={CARTO_ATTR} />
          {layers.routes && (
            <RoutesLayer disruptions={routeDisruptions} onRouteClick={(f, d) => setSelected({ type: 'route', feature: f, disruption: d })}
              hoveredId={hoveredRoute} setHoveredId={setHoveredRoute} />
          )}
          {layers.energy && (
            <ResourceLayer features={energyData.features} disruptions={disruptions}
              onResClick={(f, d) => setSelected({ type: 'resource', feature: f, disruption: d })} />
          )}
          {layers.mining && (
            <ResourceLayer features={miningData.features.filter(f => f.properties.type === 'mine')} disruptions={disruptions}
              onResClick={(f, d) => setSelected({ type: 'resource', feature: f, disruption: d })} />
          )}
          {layers.agriculture && (
            <ResourceLayer features={miningData.features.filter(f => f.properties.type !== 'mine')} disruptions={disruptions}
              onResClick={(f, d) => setSelected({ type: 'resource', feature: f, disruption: d })} />
          )}
          {layers.news && (
            <NewsLayer points={newsPoints} onPointClick={(pt) => setSelected({ type: 'news', point: pt })} />
          )}
        </MapContainer>

        <LayerControl layers={layers} toggle={toggleLayer} timeRange={timeRange} setTimeRange={setTimeRange} />

        {loading && (
          <div style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 900, fontSize: 10, color: 'var(--text-secondary)', letterSpacing: '0.1em', background: 'rgba(0,0,0,0.7)', padding: '4px 12px' }}>
            LOADING SIGNALS...
          </div>
        )}
        {!loading && newsPoints.length === 0 && layers.news && (
          <div style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 900, fontSize: 10, color: 'var(--text-secondary)', letterSpacing: '0.1em', background: 'rgba(0,0,0,0.7)', padding: '6px 14px', textAlign: 'center' }}>
            NO LOCATION DATA IN THIS WINDOW<br />
            <span style={{ fontSize: 9 }}>Analyze articles or enable auto-analyze in Settings</span>
          </div>
        )}
      </div>

      <div style={S.panel}>
        {selected?.type === 'route' && <RoutePanel feature={selected.feature} disruption={selected.disruption} />}
        {selected?.type === 'resource' && <ResourcePanel feature={selected.feature} disruption={selected.disruption} />}
        {selected?.type === 'news' && <NewsClusterPanel point={selected.point} onArticleClick={handleArticleClick} />}
        {!selected && <DefaultPanel routeDisruptions={routeDisruptions} totalArticles={newsPoints.reduce((s, p) => s + p.count, 0)} />}
      </div>
    </div>
  )
}
