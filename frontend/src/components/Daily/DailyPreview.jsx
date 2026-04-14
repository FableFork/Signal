import React, { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useApp } from '../../App'
import dayjs from 'dayjs'

export default function DailyPreview() {
  const { setTab } = useApp()
  const [digest, setDigest] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const today = dayjs().format('YYYY-MM-DD')

  const load = async () => {
    try {
      const data = await api.getDigest(today)
      setDigest(data)
    } catch {
      setDigest(null)
    }
  }

  useEffect(() => { load() }, [])

  const regenerate = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.generateDigest(today)
      if (data.error) setError(data.error)
      else setDigest(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // Pull the most meaningful summary sentence
  const d = digest?.digest
  const summary = d?.breaking_news?.summary
    || d?.macro_overview?.summary
    || d?.geopolitical?.summary
    || null

  return (
    <div style={{ padding: '10px 16px', background: 'var(--bg-secondary)' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 6,
        gap: 8,
      }}>
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: 'var(--text-secondary)',
        }}>
          DAILY BRIEF
        </span>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {digest?.generated_at && (
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
              {dayjs(digest.generated_at).format('HH:mm')}
            </span>
          )}
          <button
            className="btn"
            style={{ fontSize: 10 }}
            onClick={regenerate}
            disabled={loading}
          >
            {loading ? <span className="spin">◌</span> : '↻'}
          </button>
          <button
            className="btn btn-accent"
            style={{ fontSize: 10 }}
            onClick={() => setTab('daily')}
          >
            VIEW FULL →
          </button>
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 11, color: 'var(--bearish)', marginBottom: 4 }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          <span className="spin">◌</span> Generating digest...
        </div>
      )}

      {!loading && !digest && !error && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          No digest for today.{' '}
          <button
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 11,
              padding: 0,
              textDecoration: 'underline',
            }}
            onClick={regenerate}
          >
            Generate now
          </button>
        </div>
      )}

      {summary && !loading && (
        <div style={{
          fontSize: 12,
          color: 'var(--text-primary)',
          lineHeight: 1.5,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}>
          {summary}
        </div>
      )}
    </div>
  )
}
