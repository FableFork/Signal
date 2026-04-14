import React, { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useApp } from '../../App'
import dayjs from 'dayjs'

export default function ArticleModal({ article: initialArticle, onClose }) {
  const { setTvSymbol } = useApp()
  const [article, setArticle] = useState(initialArticle)
  const [loading, setLoading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState(null)
  const [tag, setTag] = useState(initialArticle.tag || null)

  useEffect(() => {
    // Fetch full article
    setLoading(true)
    api.getArticle(initialArticle.id)
      .then((full) => {
        setArticle(full)
        setTag(full.tag)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))

    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [initialArticle.id, onClose])

  const runAnalysis = async () => {
    setAnalyzing(true)
    setError(null)
    try {
      const result = await api.analyzeArticle(article.id)
      if (result.error) {
        setError(result.error)
      } else {
        setArticle((prev) => ({ ...prev, ai_analysis: result.result }))
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setAnalyzing(false)
    }
  }

  const setTagValue = async (t) => {
    const next = tag === t ? null : t
    setTag(next)
    await api.tagArticle(article.id, next)
  }

  const ai = article.ai_analysis

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.7)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: '100%',
        maxWidth: 800,
        maxHeight: '90vh',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700 }}>
            {article.source_name}
          </span>
          <span style={{ color: 'var(--border)' }}>·</span>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
            {dayjs(article.published_at).format('MMM D, HH:mm')}
          </span>
          <div style={{ flex: 1 }} />

          {/* Tag buttons */}
          <button
            className="btn"
            style={{ fontSize: 10, borderColor: tag === 'watching' ? 'var(--accent)' : undefined, color: tag === 'watching' ? 'var(--accent)' : undefined }}
            onClick={() => setTagValue('watching')}
          >
            {tag === 'watching' ? '★ WATCHING' : '☆ WATCH'}
          </button>
          <button
            className="btn"
            style={{ fontSize: 10, borderColor: tag === 'ignored' ? 'var(--text-secondary)' : undefined }}
            onClick={() => setTagValue('ignored')}
          >
            IGNORE
          </button>

          {article.url && (
            <a href={article.url} target="_blank" rel="noreferrer" className="btn" style={{ fontSize: 10, textDecoration: 'none' }}>
              SOURCE ↗
            </a>
          )}
          <button className="btn" onClick={onClose} style={{ fontSize: 12 }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {/* Title */}
          <h2 style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.4, marginBottom: 16, color: 'var(--text-primary)' }}>
            {article.title}
          </h2>

          {/* Body */}
          {loading ? (
            <div style={{ color: 'var(--text-secondary)' }}><span className="spin">◌</span> Loading article...</div>
          ) : (
            <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)', marginBottom: 20, whiteSpace: 'pre-wrap' }}>
              {article.body || 'Body not available. Click SOURCE to read original.'}
            </div>
          )}

          {/* AI Analysis Section */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-secondary)' }}>
                AI ANALYSIS
              </span>
              {!ai && (
                <button
                  className="btn btn-accent"
                  style={{ fontSize: 11 }}
                  onClick={runAnalysis}
                  disabled={analyzing}
                >
                  {analyzing ? <><span className="spin">◌</span> ANALYZING...</> : '▶ RUN ANALYSIS'}
                </button>
              )}
              {ai && (
                <button className="btn" style={{ fontSize: 10 }} onClick={runAnalysis} disabled={analyzing}>
                  ↻ RE-RUN
                </button>
              )}
              {article.ai_analysis && <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>(cached)</span>}
            </div>

            {error && (
              <div style={{ padding: '8px 12px', background: 'rgba(255,59,59,0.1)', border: '1px solid var(--bearish)', color: 'var(--bearish)', fontSize: 11, marginBottom: 12 }}>
                {error}
              </div>
            )}

            {ai && <AIResult ai={ai} setTvSymbol={setTvSymbol} />}
          </div>
        </div>
      </div>
    </div>
  )
}

function AIResult({ ai, setTvSymbol }) {
  const dirColor = ai.direction === 'bullish' ? 'var(--bullish)' : ai.direction === 'bearish' ? 'var(--bearish)' : 'var(--neutral)'
  const urgencyColor = ai.urgency === 'high' ? 'var(--urgency-high)' : ai.urgency === 'medium' ? 'var(--urgency-medium)' : 'var(--urgency-low)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Direction / Action / Urgency row */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <InfoChip label="DIRECTION" value={ai.direction?.toUpperCase()} color={dirColor} />
        <InfoChip label="ACTION" value={ai.action?.toUpperCase()} color={dirColor} />
        <InfoChip label="URGENCY" value={ai.urgency?.toUpperCase()} color={urgencyColor} />
        <InfoChip label="TIMEFRAME" value={ai.timeframe?.toUpperCase()} color="var(--text-primary)" />
      </div>

      {/* Conviction */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 11 }}>
          <span style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Conviction</span>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{ai.conviction}/10</span>
        </div>
        <div style={{ height: 3, background: 'var(--border)' }}>
          <div style={{
            height: '100%',
            width: `${(ai.conviction / 10) * 100}%`,
            background: ai.conviction >= 7 ? 'var(--bullish)' : ai.conviction >= 4 ? 'var(--urgency-medium)' : 'var(--bearish)',
          }} />
        </div>
      </div>

      {/* Instruments */}
      {ai.instruments_affected?.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Instruments</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {ai.instruments_affected.map((sym) => (
              <button
                key={sym}
                className="btn btn-accent"
                style={{ fontSize: 11 }}
                onClick={() => setTvSymbol(sym)}
              >
                {sym}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Industries */}
      {ai.industries_affected?.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Industries</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {ai.industries_affected.map((ind) => (
              <span key={ind} style={{ fontSize: 10, padding: '2px 8px', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                {ind}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Reasoning */}
      {ai.reasoning && (
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reasoning</div>
          <div style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.6 }}>{ai.reasoning}</div>
        </div>
      )}

      {/* Trade levels */}
      {(ai.suggested_entry || ai.suggested_stop || ai.suggested_target) && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {ai.suggested_entry && <InfoChip label="ENTRY" value={ai.suggested_entry} color="var(--text-primary)" />}
          {ai.suggested_stop && <InfoChip label="STOP" value={ai.suggested_stop} color="var(--bearish)" />}
          {ai.suggested_target && <InfoChip label="TARGET" value={ai.suggested_target} color="var(--bullish)" />}
          {ai.reward_risk_ratio && (
            <InfoChip
              label="R/R"
              value={`${Number(ai.reward_risk_ratio).toFixed(1)}:1`}
              color={Number(ai.reward_risk_ratio) >= 3 ? 'var(--bullish)' : 'var(--bearish)'}
            />
          )}
        </div>
      )}
    </div>
  )
}

function InfoChip({ label, value, color }) {
  return (
    <div style={{
      padding: '6px 10px',
      border: '1px solid var(--border)',
      background: 'var(--bg-tertiary)',
    }}>
      <div style={{ fontSize: 9, color: 'var(--text-secondary)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color }}>
        {value ?? '—'}
      </div>
    </div>
  )
}
