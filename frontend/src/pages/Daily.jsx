import React, { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../App'
import dayjs from 'dayjs'

export default function Daily() {
  const { setTvSymbol } = useApp()
  const [digest, setDigest] = useState(null)
  const [dates, setDates] = useState([])
  const [selectedDate, setSelectedDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.getDigestDates().then(setDates).catch(() => {})
  }, [])

  useEffect(() => {
    loadDigest(selectedDate)
  }, [selectedDate])

  const loadDigest = async (date) => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.getDigest(date)
      setDigest(data)
    } catch {
      setDigest(null)
    } finally {
      setLoading(false)
    }
  }

  const generate = async () => {
    setGenerating(true)
    setError(null)
    try {
      const data = await api.generateDigest(selectedDate)
      if (data.error) {
        setError(data.error)
      } else {
        setDigest(data)
        const fresh = await api.getDigestDates()
        setDates(fresh)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  const d = digest?.digest || null

  return (
    <div style={{ width: '100vw', height: 'calc(100vh - 42px)', overflowY: 'auto', padding: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--accent)' }}>
          DAILY INTELLIGENCE BRIEF
        </h1>

        <input
          type="date"
          className="input-sig"
          style={{ width: 160 }}
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
        />

        {dates.length > 0 && (
          <select className="input-sig" style={{ width: 180 }} value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}>
            {dates.map((d) => (
              <option key={d.date} value={d.date}>{d.date}</option>
            ))}
          </select>
        )}

        <button className="btn btn-accent" onClick={generate} disabled={generating}>
          {generating ? <><span className="spin">◌</span> GENERATING...</> : '↻ REGENERATE NOW'}
        </button>

        {digest?.generated_at && (
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Generated {dayjs(digest.generated_at).format('MMM D HH:mm')}
          </span>
        )}
      </div>

      {error && (
        <div style={{ padding: '12px 16px', background: 'rgba(255,59,59,0.1)', border: '1px solid var(--bearish)', color: 'var(--bearish)', marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>
          <span className="spin">◌</span> Loading...
        </div>
      )}

      {!loading && !digest && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>
          No digest for {selectedDate}. Click REGENERATE NOW to generate.
        </div>
      )}

      {d && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 960 }}>
          <DigestSection title="BREAKING NEWS" data={d.breaking_news} />
          <DigestSection title="MACRO OVERVIEW" data={d.macro_overview} />
          <DigestSection title="GEOPOLITICAL" data={d.geopolitical} />
          <DigestSection title="ENERGY" data={d.energy} />
          <DigestSection title="METALS" data={d.metals} />
          <DigestSection title="EQUITIES" data={d.equities} />
          <DigestSection title="CRYPTO" data={d.crypto} />
          <WatchlistSection data={d.suggested_watchlist || d.watchlist} setTvSymbol={setTvSymbol} />
          <DataEventsSection data={d.data_events} />
        </div>
      )}
    </div>
  )
}

function DigestSection({ title, data }) {
  const [open, setOpen] = useState(true)
  if (!data) return null

  const summary = typeof data === 'string' ? data : data.summary
  const items = data?.items || []

  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: '10px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
          borderBottom: open ? '1px solid var(--border)' : 'none',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--accent)' }}>{title}</span>
        <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ padding: '12px 16px' }}>
          {summary && (
            <p style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-primary)', marginBottom: items.length ? 10 : 0 }}>
              {summary}
            </p>
          )}
          {items.map((item, i) => (
            <div key={i} style={{
              padding: '6px 0',
              borderTop: '1px solid var(--border)',
              fontSize: 12,
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
            }}>
              {typeof item === 'string' ? item : JSON.stringify(item)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function WatchlistSection({ data, setTvSymbol }) {
  const [open, setOpen] = useState(true)
  if (!data || !Array.isArray(data) || data.length === 0) return null

  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: '10px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
          borderBottom: open ? '1px solid var(--border)' : 'none',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--accent)' }}>
          SUGGESTED WATCHLIST
        </span>
        <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.map((item, i) => {
            const biasColor = item.bias === 'bullish' ? 'var(--bullish)'
              : item.bias === 'bearish' ? 'var(--bearish)' : 'var(--neutral)'
            return (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 12px',
                border: '1px solid var(--border)',
                background: 'var(--bg-tertiary)',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 2 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{item.ticker}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{item.name}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: biasColor, textTransform: 'uppercase' }}>
                      {item.bias}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{item.reason}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button className="btn btn-accent" style={{ fontSize: 10 }}
                    onClick={() => setTvSymbol(item.ticker)}>
                    CHART
                  </button>
                  <button className="btn" style={{ fontSize: 10 }}
                    onClick={() => window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(item.ticker)}`, '_blank')}>
                    ↗ TV
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DataEventsSection({ data }) {
  const [open, setOpen] = useState(true)
  if (!data || !Array.isArray(data) || data.length === 0) return null

  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: '10px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          cursor: 'pointer',
          borderBottom: open ? '1px solid var(--border)' : 'none',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--accent)' }}>DATA EVENTS TODAY</span>
        <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ padding: '8px 12px' }}>
          {data.map((ev, i) => (
            <div key={i} style={{
              display: 'flex',
              gap: 12,
              padding: '6px 0',
              borderBottom: '1px solid var(--border)',
              fontSize: 12,
            }}>
              <span style={{ color: 'var(--accent)', fontWeight: 700, width: 60, flexShrink: 0 }}>
                {ev.time_utc4}
              </span>
              <span style={{ color: 'var(--text-primary)', flex: 1 }}>{ev.event}</span>
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                color: ev.importance === 'high' ? 'var(--urgency-high)'
                  : ev.importance === 'medium' ? 'var(--urgency-medium)' : 'var(--text-secondary)',
                textTransform: 'uppercase',
                flexShrink: 0,
              }}>
                {ev.importance}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
