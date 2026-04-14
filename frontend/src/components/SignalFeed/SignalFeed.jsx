import React, { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../../lib/api'
import { useApp } from '../../App'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
dayjs.extend(relativeTime)

const CATEGORY_COLORS = {
  general: '#00d4ff',
  geopolitical: '#ff6b00',
  energy: '#f5c518',
  markets: '#00ff88',
  crypto: '#a78bfa',
  metals: '#e5e7eb',
}

export default function SignalFeed() {
  const { onNewArticle, offNewArticle, refreshUnread, setSelectedArticle } = useApp()
  const [articles, setArticles] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState({ source: '', since_hours: '', keyword: '' })
  const [hover, setHover] = useState(null)
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 })
  const containerRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = {}
      if (filter.source) params.source = filter.source
      if (filter.since_hours) params.since_hours = filter.since_hours
      if (filter.keyword) params.keyword = filter.keyword
      const data = await api.getArticles({ ...params, limit: 100 })
      setArticles(data)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const handler = (article) => {
      setArticles((prev) => {
        if (prev.find((a) => a.guid === article.guid)) return prev
        return [{ ...article, _new: true }, ...prev]
      })
    }
    onNewArticle(handler)
    return () => offNewArticle(handler)
  }, [onNewArticle, offNewArticle])

  const sources = [...new Set(articles.map((a) => a.source_name).filter(Boolean))]

  const handleCardClick = (article) => {
    setSelectedArticle(article)
    refreshUnread()
  }

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-secondary)' }}>
            SIGNAL FEED
          </span>
          <button className="btn" style={{ fontSize: 10 }} onClick={load}>↻ REFRESH</button>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select
            className="input-sig"
            style={{ width: 'auto', flex: 1 }}
            value={filter.source}
            onChange={(e) => setFilter((f) => ({ ...f, source: e.target.value }))}
          >
            <option value="">All Sources</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <select
            className="input-sig"
            style={{ width: 'auto', flex: 1 }}
            value={filter.since_hours}
            onChange={(e) => setFilter((f) => ({ ...f, since_hours: e.target.value }))}
          >
            <option value="">All Time</option>
            <option value="1">Last 1h</option>
            <option value="6">Last 6h</option>
            <option value="24">Last 24h</option>
          </select>
        </div>

        <div style={{ marginTop: 6 }}>
          <input
            className="input-sig"
            placeholder="Search keywords..."
            value={filter.keyword}
            onChange={(e) => setFilter((f) => ({ ...f, keyword: e.target.value }))}
          />
        </div>
      </div>

      {/* Article list */}
      <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        {loading && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)' }}>
            <span className="spin">◌</span> Loading...
          </div>
        )}

        {!loading && articles.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 12 }}>
            No articles. Configure RSS sources in Settings.
          </div>
        )}

        {articles.map((article) => (
          <ArticleCard
            key={article.guid}
            article={article}
            onClick={() => handleCardClick(article)}
            onMouseEnter={(e) => {
              setHover(article)
              setHoverPos({ x: e.clientX, y: e.clientY })
            }}
            onMouseMove={(e) => setHoverPos({ x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </div>

      {/* Hover pane */}
      {hover && (
        <HoverPane article={hover} pos={hoverPos} />
      )}

    </div>
  )
}

function ArticleCard({ article, onClick, onMouseEnter, onMouseMove, onMouseLeave }) {
  const catColor = CATEGORY_COLORS[article.category] || '#888'
  const isNew = article._new
  const isUnread = !article.read

  return (
    <div
      className={`card-hover${isNew ? ' slide-in' : ''}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      style={{
        display: 'flex',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        borderLeft: `3px solid ${catColor}`,
        background: isNew ? 'var(--accent-dim)' : isUnread ? 'rgba(255,255,255,0.02)' : 'transparent',
        cursor: 'pointer',
        position: 'relative',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 3,
          gap: 8,
        }}>
          <span style={{
            fontSize: 10,
            color: catColor,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            flexShrink: 0,
          }}>
            {article.source_name}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0 }}>
            {dayjs(article.published_at).fromNow()}
          </span>
        </div>

        <div style={{
          fontSize: 12,
          fontWeight: isUnread ? 600 : 400,
          color: 'var(--text-primary)',
          lineHeight: 1.4,
          marginBottom: 3,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}>
          {article.title}
        </div>

        {article.snippet && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.3 }}>
            {article.snippet}
          </div>
        )}

        {article.tag && (
          <span style={{
            marginTop: 4,
            display: 'inline-block',
            fontSize: 9,
            fontWeight: 700,
            textTransform: 'uppercase',
            padding: '1px 6px',
            border: '1px solid',
            borderColor: article.tag === 'watching' ? 'var(--accent)' : 'var(--text-secondary)',
            color: article.tag === 'watching' ? 'var(--accent)' : 'var(--text-secondary)',
          }}>
            {article.tag}
          </span>
        )}
      </div>

      {isNew && (
        <div style={{
          position: 'absolute',
          top: 8,
          right: 8,
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--accent)',
        }} className="pulse" />
      )}
    </div>
  )
}

function HoverPane({ article, pos }) {
  const paneWidth = 320
  const paneHeight = 220

  let x = pos.x + 16
  let y = pos.y + 8

  if (x + paneWidth > window.innerWidth) x = pos.x - paneWidth - 8
  if (y + paneHeight > window.innerHeight) y = pos.y - paneHeight - 8

  return (
    <div style={{
      position: 'fixed',
      left: x,
      top: y,
      width: paneWidth,
      background: 'var(--bg-secondary)',
      border: '1px solid var(--accent)',
      padding: 14,
      zIndex: 9999,
      pointerEvents: 'none',
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--accent)', marginBottom: 4, fontWeight: 700 }}>
        {article.source_name} · {dayjs(article.published_at).fromNow()}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, lineHeight: 1.4, color: 'var(--text-primary)' }}>
        {article.title}
      </div>
      {article.snippet && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {article.snippet}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-secondary)' }}>
        Click to open full article
      </div>
    </div>
  )
}
