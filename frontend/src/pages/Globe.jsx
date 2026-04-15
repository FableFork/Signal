import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { api } from '../lib/api'
import { useApp } from '../App'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

const DIR_COLOR = {
  bullish: '#00ff88',
  bearish: '#ff3b3b',
  neutral: '#888888',
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Globe() {
  const { setSelectedArticle, setTab, settings } = useApp()
  const containerRef = useRef(null)
  const globeRef = useRef(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [GlobeComponent, setGlobeComponent] = useState(null)
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [globeReady, setGlobeReady] = useState(false)

  // Dynamically load react-globe.gl (heavy, ~1MB — lazy so it doesn't block app startup)
  useEffect(() => {
    import('react-globe.gl').then((mod) => setGlobeComponent(() => mod.default)).catch(() => {})
  }, [])

  // Filters
  const [timeRange, setTimeRange] = useState(48)
  const [categoryFilter, setCategoryFilter] = useState(null)
  const [urgencyFilter, setUrgencyFilter] = useState(null)
  const [dirFilter, setDirFilter] = useState(null)
  const [instrumentFilter, setInstrumentFilter] = useState(null)

  // Selection / panel
  const [selectedPoint, setSelectedPoint] = useState(null)
  const [showPanel, setShowPanel] = useState(true)
  const [hoveredPoint, setHoveredPoint] = useState(null)

  // Track panel width for globe resizing
  const PANEL_W = showPanel ? 380 : 0

  // ── Measure container ──
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(() => {
      const el = containerRef.current
      if (el) setDims({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // ── Fetch data ──
  const loadData = useCallback(() => {
    setLoading(true)
    setError(null)
    api.globeData({ since_hours: timeRange })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [timeRange])

  useEffect(() => { loadData() }, [loadData])

  // ── Apply filters ──
  const filtered = useMemo(() => {
    return data.filter((a) => {
      if (categoryFilter && a.category !== categoryFilter) return false
      if (urgencyFilter && a.urgency !== urgencyFilter) return false
      if (dirFilter && a.direction !== dirFilter) return false
      if (instrumentFilter && !(a.instruments_affected || []).includes(instrumentFilter)) return false
      return true
    })
  }, [data, categoryFilter, urgencyFilter, dirFilter, instrumentFilter])

  // ── Aggregate points (per location) ──
  const points = useMemo(() => {
    const map = new Map()
    for (const article of filtered) {
      for (const loc of (article.locations_affected || [])) {
        if (loc.lat == null || loc.lng == null) continue
        // Round to 1 decimal to merge near-identical coords
        const key = `${Math.round(loc.lat * 10) / 10},${Math.round(loc.lng * 10) / 10}`
        if (!map.has(key)) {
          map.set(key, {
            lat: loc.lat,
            lng: loc.lng,
            name: loc.name,
            articles: [],
            dirCounts: { bullish: 0, bearish: 0, neutral: 0 },
            maxConviction: 0,
            hasHighUrgency: false,
          })
        }
        const pt = map.get(key)
        pt.articles.push(article)
        const dir = article.direction || 'neutral'
        pt.dirCounts[dir] = (pt.dirCounts[dir] || 0) + 1
        pt.maxConviction = Math.max(pt.maxConviction, article.conviction || 0)
        if (article.urgency === 'high') pt.hasHighUrgency = true
      }
    }
    return Array.from(map.values()).map((pt) => {
      const dominant = Object.entries(pt.dirCounts).sort((a, b) => b[1] - a[1])[0][0]
      const count = pt.articles.length
      return {
        ...pt,
        dominant,
        color: DIR_COLOR[dominant] || '#888888',
        // Altitude scales with conviction + article count
        altitude: 0.005 + (pt.maxConviction / 10) * 0.06 + Math.min(count, 10) * 0.005,
        radius: 0.35 + Math.min(count, 8) * 0.12 + (pt.maxConviction / 10) * 0.3,
      }
    })
  }, [filtered])

  // ── Arcs (location pairs within the same article) ──
  const arcs = useMemo(() => {
    const result = []
    for (const article of filtered) {
      const locs = (article.locations_affected || []).filter((l) => l.lat != null && l.lng != null)
      for (let i = 0; i < locs.length - 1; i++) {
        const col = DIR_COLOR[article.direction] || '#888888'
        result.push({
          startLat: locs[i].lat,
          startLng: locs[i].lng,
          endLat: locs[i + 1].lat,
          endLng: locs[i + 1].lng,
          colorStr: col + '55',
          article,
        })
      }
    }
    return result
  }, [filtered])

  // ── Rings on high-urgency points ──
  const rings = useMemo(() => {
    return points
      .filter((p) => p.hasHighUrgency)
      .map((p) => ({
        lat: p.lat,
        lng: p.lng,
        maxR: 4,
        propagationSpeed: 2.5,
        repeatPeriod: 1000,
      }))
  }, [points])

  // ── Panel articles ──
  const panelArticles = useMemo(() => {
    if (selectedPoint) {
      return filtered.filter((a) =>
        (a.locations_affected || []).some(
          (l) => l.name === selectedPoint.name
        )
      )
    }
    return filtered.filter((a) => (a.locations_affected || []).length > 0).slice(0, 50)
  }, [selectedPoint, filtered])

  // ── Top instruments across filtered data ──
  const topInstruments = useMemo(() => {
    const counts = {}
    for (const a of filtered) {
      for (const sym of (a.instruments_affected || [])) {
        counts[sym] = (counts[sym] || 0) + 1
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([sym]) => sym)
  }, [filtered])

  // ── Stats ──
  const stats = useMemo(() => {
    const total = filtered.length
    const bullish = filtered.filter((a) => a.direction === 'bullish').length
    const bearish = filtered.filter((a) => a.direction === 'bearish').length
    const locationCount = new Set(
      filtered.flatMap((a) => (a.locations_affected || []).map((l) => l.name))
    ).size
    return { total, bullish, bearish, neutral: total - bullish - bearish, locationCount }
  }, [filtered])

  const openArticle = (article) => {
    setSelectedArticle(article)
    setTab('dashboard')
  }

  const handlePointClick = (pt) => {
    setSelectedPoint((prev) => (prev?.name === pt.name ? null : pt))
    setShowPanel(true)
  }

  const handlePointHover = (pt) => {
    setHoveredPoint(pt || null)
    if (containerRef.current) {
      containerRef.current.style.cursor = pt ? 'pointer' : 'default'
    }
  }

  const clearFilters = () => {
    setCategoryFilter(null)
    setUrgencyFilter(null)
    setDirFilter(null)
    setInstrumentFilter(null)
    setSelectedPoint(null)
  }

  const hasFilters = categoryFilter || urgencyFilter || dirFilter || instrumentFilter || selectedPoint
  const globeW = dims.w - PANEL_W
  const globeH = dims.h

  return (
    <div
      ref={containerRef}
      style={{
        width: '100vw',
        height: 'calc(100vh - 42px)',
        display: 'flex',
        background: '#000000',
        position: 'relative',
        overflow: 'hidden',
        fontFamily: 'var(--font)',
      }}
    >
      {/* ── Globe container ── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>

        {/* Top bar */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.85) 60%, transparent)',
          flexWrap: 'wrap',
          pointerEvents: 'none',
        }}>
          {/* Left side — all pointer-events re-enabled per element */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1, pointerEvents: 'auto' }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.15em', color: 'var(--accent)', marginRight: 6 }}>
              ◉ GLOBE
            </span>

            {/* Time range */}
            <FilterGroup>
              {[
                { v: 6, l: '6H' }, { v: 24, l: '24H' },
                { v: 48, l: '48H' }, { v: 168, l: '7D' },
              ].map(({ v, l }) => (
                <FilterBtn key={v} active={timeRange === v} onClick={() => { setTimeRange(v); setSelectedPoint(null) }}>
                  {l}
                </FilterBtn>
              ))}
            </FilterGroup>

            <Sep />

            {/* Direction */}
            <FilterGroup>
              {['bullish', 'bearish', 'neutral'].map((d) => (
                <FilterBtn
                  key={d} active={dirFilter === d}
                  color={DIR_COLOR[d]}
                  onClick={() => setDirFilter(dirFilter === d ? null : d)}
                >
                  {d === 'bullish' ? '▲' : d === 'bearish' ? '▼' : '◆'} {d.toUpperCase()}
                </FilterBtn>
              ))}
            </FilterGroup>

            <Sep />

            {/* Urgency */}
            <FilterGroup>
              {['high', 'medium', 'low'].map((u) => (
                <FilterBtn
                  key={u} active={urgencyFilter === u}
                  color={u === 'high' ? 'var(--urgency-high)' : u === 'medium' ? '#ffaa00' : 'var(--text-secondary)'}
                  onClick={() => setUrgencyFilter(urgencyFilter === u ? null : u)}
                >
                  {u.toUpperCase()}
                </FilterBtn>
              ))}
            </FilterGroup>

            <Sep />

            {/* Category */}
            <FilterGroup>
              {['energy', 'markets', 'geopolitical', 'general'].map((c) => (
                <FilterBtn key={c} active={categoryFilter === c} onClick={() => setCategoryFilter(categoryFilter === c ? null : c)}>
                  {c.toUpperCase()}
                </FilterBtn>
              ))}
            </FilterGroup>

            {hasFilters && (
              <button
                onClick={clearFilters}
                className="btn"
                style={{ fontSize: 9, padding: '2px 8px', borderColor: 'var(--bearish)', color: 'var(--bearish)', marginLeft: 4 }}
              >
                ✕ CLEAR
              </button>
            )}
          </div>

          {/* Right side — stats + toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, pointerEvents: 'auto' }}>
            <StatChip label="TOTAL" value={stats.total} color="var(--text-secondary)" />
            <StatChip label="▲" value={stats.bullish} color={DIR_COLOR.bullish} />
            <StatChip label="▼" value={stats.bearish} color={DIR_COLOR.bearish} />
            <StatChip label="◆" value={stats.neutral} color={DIR_COLOR.neutral} />
            <StatChip label="LOCATIONS" value={stats.locationCount} color="var(--accent)" />
            <button
              className="btn"
              style={{ fontSize: 9, padding: '2px 8px' }}
              onClick={() => setShowPanel((p) => !p)}
            >
              {showPanel ? '▶ HIDE' : '◀ FEED'}
            </button>
            <button
              className="btn"
              style={{ fontSize: 9, padding: '2px 8px' }}
              onClick={loadData}
              disabled={loading}
            >
              {loading ? <span className="spin">◌</span> : '↻'}
            </button>
          </div>
        </div>

        {/* Instrument chips — second row */}
        {topInstruments.length > 0 && (
          <div style={{
            position: 'absolute', top: 50, left: 14, zIndex: 20,
            display: 'flex', gap: 4, flexWrap: 'wrap',
            pointerEvents: 'auto',
          }}>
            {topInstruments.map((sym) => (
              <button
                key={sym}
                onClick={() => setInstrumentFilter(instrumentFilter === sym ? null : sym)}
                style={{
                  fontSize: 9, padding: '2px 7px',
                  background: instrumentFilter === sym ? 'var(--accent)' : 'rgba(0,0,0,0.7)',
                  border: `1px solid ${instrumentFilter === sym ? 'var(--accent)' : 'var(--border)'}`,
                  color: instrumentFilter === sym ? 'var(--bg-primary)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                }}
              >
                {sym}
              </button>
            ))}
          </div>
        )}

        {/* Hovered point tooltip */}
        {hoveredPoint && (
          <div style={{
            position: 'absolute', bottom: 24, left: 24, zIndex: 20,
            background: 'rgba(7,7,9,0.92)',
            border: '1px solid var(--border)',
            padding: '10px 14px',
            pointerEvents: 'none',
            maxWidth: 300,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', marginBottom: 4 }}>
              {hoveredPoint.name}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 6 }}>
              {hoveredPoint.articles.length} article{hoveredPoint.articles.length !== 1 ? 's' : ''}
              {' · '}
              <span style={{ color: DIR_COLOR[hoveredPoint.dominant], fontWeight: 700 }}>
                {hoveredPoint.dominant?.toUpperCase()}
              </span>
              {' · '}conviction {hoveredPoint.maxConviction}/10
            </div>
            {hoveredPoint.articles.slice(0, 2).map((a) => (
              <div key={a.id} style={{ fontSize: 10, color: 'var(--text-primary)', lineHeight: 1.4, marginBottom: 3 }}>
                • {a.title?.slice(0, 80)}{a.title?.length > 80 ? '…' : ''}
              </div>
            ))}
            {hoveredPoint.articles.length > 2 && (
              <div style={{ fontSize: 9, color: 'var(--text-secondary)', marginTop: 2 }}>
                +{hoveredPoint.articles.length - 2} more — click to expand
              </div>
            )}
          </div>
        )}

        {/* Globe */}
        {dims.w > 0 && GlobeComponent ? (
          <GlobeComponent
            ref={globeRef}
            width={globeW}
            height={globeH}
            backgroundColor="#000000"
            globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
            bumpImageUrl="//unpkg.com/three-globe/example/img/earth-topology.png"
            atmosphereColor="rgba(0,255,64,0.12)"
            atmosphereAltitude={0.18}
            onGlobeReady={() => setGlobeReady(true)}
            // Points
            pointsData={points}
            pointLat="lat"
            pointLng="lng"
            pointAltitude="altitude"
            pointRadius="radius"
            pointColor="color"
            pointsMerge={false}
            pointLabel={(d) => `
              <div style="background:rgba(0,0,0,0.88);border:1px solid #1e1e2e;padding:8px 12px;font-size:11px;font-family:monospace;pointer-events:none;min-width:140px">
                <div style="font-weight:700;color:#00ff40;margin-bottom:4px">${d.name}</div>
                <div style="color:#888;margin-bottom:3px">${d.articles.length} article${d.articles.length !== 1 ? 's' : ''}</div>
                <div style="color:${d.color};font-weight:700;text-transform:uppercase;font-size:10px">${d.dominant}</div>
                <div style="color:#555;font-size:10px">conviction ${d.maxConviction}/10</div>
              </div>
            `}
            onPointClick={handlePointClick}
            onPointHover={handlePointHover}
            // Arcs
            arcsData={arcs}
            arcStartLat="startLat"
            arcStartLng="startLng"
            arcEndLat="endLat"
            arcEndLng="endLng"
            arcColor="colorStr"
            arcDashLength={0.25}
            arcDashGap={0.08}
            arcDashAnimateTime={3000}
            arcStroke={0.4}
            arcAltitudeAutoScale={0.4}
            // Rings
            ringsData={rings}
            ringLat="lat"
            ringLng="lng"
            ringMaxRadius="maxR"
            ringPropagationSpeed="propagationSpeed"
            ringRepeatPeriod="repeatPeriod"
            ringColor={() => '#ff6b00'}
            ringAltitude={0.005}
          />
        ) : (
          <GlobeLoadingState />
        )}

        {/* Empty state */}
        {!loading && globeReady && filtered.length === 0 && (
          <div style={{
            position: 'absolute',
            bottom: 60,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.85)',
            border: '1px solid var(--border)',
            padding: '12px 20px',
            fontSize: 12,
            color: 'var(--text-secondary)',
            textAlign: 'center',
            zIndex: 20,
            maxWidth: 420,
            lineHeight: 1.6,
          }}>
            {data.length === 0
              ? <>No analyzed articles in this time window.<br />Open articles on the Dashboard and run AI Analysis — or enable Auto-Analyze in Settings.</>
              : 'No articles match current filters.'}
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            position: 'absolute', top: 80, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(255,59,59,0.15)', border: '1px solid var(--bearish)',
            padding: '8px 16px', fontSize: 11, color: 'var(--bearish)', zIndex: 20,
          }}>
            {error}
          </div>
        )}
      </div>

      {/* ── Side panel ── */}
      {showPanel && (
        <div style={{
          width: PANEL_W,
          height: '100%',
          background: 'var(--bg-secondary)',
          borderLeft: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          flexShrink: 0,
        }}>
          {/* Panel header */}
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: selectedPoint ? 8 : 0 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.1em', flex: 1 }}>
                {selectedPoint ? selectedPoint.name.toUpperCase() : 'ALL LOCATIONS'}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                {panelArticles.length} article{panelArticles.length !== 1 ? 's' : ''}
              </span>
              {selectedPoint && (
                <button
                  className="btn"
                  style={{ fontSize: 9, padding: '1px 7px' }}
                  onClick={() => setSelectedPoint(null)}
                >
                  ✕
                </button>
              )}
            </div>
            {selectedPoint && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['bullish', 'bearish', 'neutral'].map((d) => {
                  const count = panelArticles.filter((a) => a.direction === d).length
                  if (!count) return null
                  return (
                    <span key={d} style={{
                      fontSize: 9, padding: '2px 8px',
                      border: `1px solid ${DIR_COLOR[d]}44`,
                      color: DIR_COLOR[d],
                      background: `${DIR_COLOR[d]}11`,
                    }}>
                      {d.toUpperCase()} {count}
                    </span>
                  )
                })}
              </div>
            )}
          </div>

          {/* Article list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {panelArticles.length === 0 ? (
              <div style={{ padding: '20px 14px', color: 'var(--text-secondary)', fontSize: 12 }}>
                No articles at this location.
              </div>
            ) : (
              panelArticles.map((article) => (
                <ArticleRow
                  key={article.id}
                  article={article}
                  onClick={() => openArticle(article)}
                />
              ))
            )}
          </div>

          {/* Legend */}
          <div style={{
            padding: '8px 14px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            flexShrink: 0,
          }}>
            <LegendItem color={DIR_COLOR.bullish} label="Bullish" />
            <LegendItem color={DIR_COLOR.bearish} label="Bearish" />
            <LegendItem color={DIR_COLOR.neutral} label="Neutral" />
            <LegendItem color="#ff6b00" label="High urgency (rings)" ring />
          </div>
        </div>
      )}
    </div>
  )
}


// ─── Sub-components ───────────────────────────────────────────────────────────
function ArticleRow({ article, onClick }) {
  const col = DIR_COLOR[article.direction] || '#888888'
  return (
    <div
      onClick={onClick}
      style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {/* Meta row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase' }}>
          {article.source_name}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}>
          {dayjs(article.published_at).fromNow()}
        </span>
        <div style={{ flex: 1 }} />
        {article.urgency === 'high' && (
          <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--urgency-high)', letterSpacing: '0.05em' }}>
            ● URGENT
          </span>
        )}
        <span style={{ fontSize: 9, fontWeight: 700, color: col, textTransform: 'uppercase' }}>
          {article.direction?.[0]?.toUpperCase()}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}>{article.conviction}/10</span>
      </div>

      {/* Title */}
      <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--text-primary)', marginBottom: 6 }}>
        {article.title}
      </div>

      {/* Instruments */}
      {(article.instruments_affected || []).length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {article.instruments_affected.slice(0, 5).map((sym) => (
            <span key={sym} style={{
              fontSize: 9, padding: '1px 6px',
              border: `1px solid ${col}44`,
              color: col,
              background: `${col}11`,
            }}>
              {sym}
            </span>
          ))}
        </div>
      )}

      {/* Locations */}
      {(article.locations_affected || []).length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
          {article.locations_affected.slice(0, 4).map((l) => (
            <span key={l.name} style={{
              fontSize: 9, padding: '1px 5px',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
            }}>
              📍 {l.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function FilterGroup({ children }) {
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
      {children}
    </div>
  )
}

function FilterBtn({ children, active, color, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 9,
        padding: '2px 8px',
        background: active ? (color ? `${color}22` : 'rgba(0,255,64,0.12)') : 'rgba(0,0,0,0.7)',
        border: `1px solid ${active ? (color || 'var(--accent)') : 'var(--border)'}`,
        color: active ? (color || 'var(--accent)') : 'var(--text-secondary)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontWeight: 700,
        letterSpacing: '0.05em',
        transition: 'all 0.12s',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  )
}

function Sep() {
  return <div style={{ width: 1, height: 14, background: 'var(--border)', margin: '0 2px' }} />
}

function StatChip({ label, value, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ fontSize: 9, color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 700, color }}>{value}</span>
    </div>
  )
}

function LegendItem({ color, label, ring }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div style={{
        width: ring ? 8 : 8, height: ring ? 8 : 8,
        borderRadius: '50%',
        background: ring ? 'transparent' : color,
        border: ring ? `2px solid ${color}` : 'none',
      }} />
      <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}>{label}</span>
    </div>
  )
}

function GlobeLoadingState() {
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-secondary)', fontSize: 12, gap: 10,
    }}>
      <span className="spin">◌</span>
      <span>Loading globe...</span>
    </div>
  )
}
