import React, { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useApp } from '../../App'
import dayjs from 'dayjs'

export default function ArticleReader() {
  const { selectedArticle, setSelectedArticle, setTvSymbol } = useApp()
  const [article, setArticle] = useState(null)
  const [loading, setLoading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState(null)
  const [tag, setTag] = useState(null)

  useEffect(() => {
    if (!selectedArticle) return
    setError(null)
    setLoading(true)
    setArticle(null)
    api.getArticle(selectedArticle.id)
      .then((full) => {
        setArticle(full)
        setTag(full.tag)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [selectedArticle?.id])

  const runAnalysis = async () => {
    if (!article) return
    setAnalyzing(true)
    setError(null)
    try {
      const result = await api.analyzeArticle(article.id)
      if (result.error) setError(result.error)
      else setArticle((prev) => ({ ...prev, ai_analysis: result.result }))
    } catch (e) {
      setError(e.message)
    } finally {
      setAnalyzing(false)
    }
  }

  const setTagValue = async (t) => {
    if (!article) return
    const next = tag === t ? null : t
    setTag(next)
    await api.tagArticle(article.id, next)
  }

  // Empty state
  if (!selectedArticle) {
    return (
      <div style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-secondary)',
        gap: 12,
        padding: 32,
      }}>
        <div style={{ fontSize: 32, opacity: 0.3 }}>◎</div>
        <div style={{ fontSize: 12, textAlign: 'center', lineHeight: 1.6 }}>
          Click any article in the feed<br />to read it here
        </div>
      </div>
    )
  }

  const ai = article?.ai_analysis

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Article header */}
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          {article && (
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase' }}>
              {article.source_name}
            </span>
          )}
          {article && (
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
              {dayjs(article.published_at).format('MMM D, HH:mm')}
            </span>
          )}
          <div style={{ flex: 1 }} />

          {/* Tag buttons */}
          <button
            className="btn"
            style={{
              fontSize: 10,
              borderColor: tag === 'watching' ? 'var(--accent)' : undefined,
              color: tag === 'watching' ? 'var(--accent)' : undefined,
            }}
            onClick={() => setTagValue('watching')}
          >
            {tag === 'watching' ? '★ WATCHING' : '☆ WATCH'}
          </button>
          <button
            className="btn"
            style={{
              fontSize: 10,
              borderColor: tag === 'ignored' ? 'var(--text-secondary)' : undefined,
            }}
            onClick={() => setTagValue('ignored')}
          >
            IGNORE
          </button>
          {article?.url && (
            <a href={article.url} target="_blank" rel="noreferrer"
              className="btn" style={{ fontSize: 10, textDecoration: 'none' }}>
              SOURCE ↗
            </a>
          )}
          <button
            className="btn"
            style={{ fontSize: 10 }}
            onClick={() => setSelectedArticle(null)}
          >
            ✕
          </button>
        </div>

        {/* Title */}
        {(article || selectedArticle) && (
          <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.4, color: 'var(--text-primary)' }}>
            {article?.title || selectedArticle?.title}
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
        {loading && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
            <span className="spin">◌</span> Loading article...
          </div>
        )}

        {error && (
          <div style={{
            padding: '8px 12px',
            background: 'rgba(255,59,59,0.1)',
            border: '1px solid var(--bearish)',
            color: 'var(--bearish)',
            fontSize: 11,
            marginBottom: 12,
          }}>
            {error}
          </div>
        )}

        {/* Article body */}
        {article?.body && (
          <div style={{
            fontSize: 12,
            lineHeight: 1.75,
            color: 'var(--text-secondary)',
            marginBottom: 20,
            whiteSpace: 'pre-wrap',
          }}>
            {article.body}
          </div>
        )}

        {article && !article.body && !loading && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 20 }}>
            Body not available.{' '}
            {article.url && (
              <a href={article.url} target="_blank" rel="noreferrer"
                style={{ color: 'var(--accent)' }}>
                Read original ↗
              </a>
            )}
          </div>
        )}

        {/* AI Analysis */}
        {article && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                color: 'var(--text-secondary)', textTransform: 'uppercase',
              }}>
                AI Analysis
              </span>
              {!ai && (
                <button
                  className="btn btn-accent"
                  style={{ fontSize: 11 }}
                  onClick={runAnalysis}
                  disabled={analyzing}
                >
                  {analyzing
                    ? <><span className="spin">◌</span> Analyzing...</>
                    : '▶ Run Analysis'}
                </button>
              )}
              {ai && (
                <button className="btn" style={{ fontSize: 10 }} onClick={runAnalysis} disabled={analyzing}>
                  {analyzing ? <span className="spin">◌</span> : '↻ Re-run'}
                </button>
              )}
              {ai && !analyzing && (
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>cached</span>
              )}
            </div>

            {ai && <AIResult ai={ai} setTvSymbol={setTvSymbol} />}
          </div>
        )}
      </div>
    </div>
  )
}

const INSTRUMENT_NAMES = {
  // Futures
  'CL=F': 'Crude Oil WTI', 'BZ=F': 'Brent Crude', 'NG=F': 'Natural Gas',
  'GC=F': 'Gold', 'SI=F': 'Silver', 'HG=F': 'Copper', 'PL=F': 'Platinum',
  'PA=F': 'Palladium', 'ZW=F': 'Wheat', 'ZC=F': 'Corn', 'ZS=F': 'Soybeans',
  'ZO=F': 'Oats', 'KC=F': 'Coffee', 'SB=F': 'Sugar', 'CT=F': 'Cotton',
  'RB=F': 'RBOB Gasoline', 'HO=F': 'Heating Oil', 'LBS=F': 'Lumber',
  'ES=F': 'S&P 500 Futures', 'NQ=F': 'Nasdaq Futures', 'YM=F': 'Dow Futures',
  'RTY=F': 'Russell 2000 Futures', 'VX=F': 'VIX Futures',
  // Forex
  'EURUSD=X': 'EUR/USD', 'GBPUSD=X': 'GBP/USD', 'USDJPY=X': 'USD/JPY',
  'USDCHF=X': 'USD/CHF', 'AUDUSD=X': 'AUD/USD', 'USDCAD=X': 'USD/CAD',
  'NZDUSD=X': 'NZD/USD', 'USDCNH=X': 'USD/CNH', 'DX-Y.NYB': 'US Dollar Index',
  'DXY': 'US Dollar Index',
  // Crypto
  'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum', 'BNB-USD': 'BNB',
  'XRP-USD': 'XRP', 'SOL-USD': 'Solana',
  // Major ETFs
  'SPY': 'S&P 500 ETF', 'QQQ': 'Nasdaq 100 ETF', 'IWM': 'Russell 2000 ETF',
  'DIA': 'Dow Jones ETF', 'TLT': 'Long-Term Treasury ETF', 'GLD': 'Gold ETF',
  'SLV': 'Silver ETF', 'USO': 'Oil ETF', 'UNG': 'Natural Gas ETF',
  'XLE': 'Energy Sector ETF', 'XLF': 'Financials ETF', 'XLK': 'Tech ETF',
  'XLU': 'Utilities ETF', 'XLI': 'Industrials ETF', 'XLB': 'Materials ETF',
  'XLP': 'Consumer Staples ETF', 'XLY': 'Consumer Disc. ETF', 'XLV': 'Healthcare ETF',
  'EEM': 'Emerging Markets ETF', 'EFA': 'Developed Markets ETF',
  'HYG': 'High Yield Bond ETF', 'LQD': 'Corp Bond ETF', 'TIP': 'TIPS ETF',
  'VNQ': 'Real Estate ETF', 'IAU': 'Gold ETF (iShares)',
  // Shipping / Energy stocks
  'EURN': 'Euronav (Shipping)', 'FRO': 'Frontline (Tankers)',
  'TNK': 'Teekay Tankers', 'DHT': 'DHT Holdings',
  'XOM': 'ExxonMobil', 'CVX': 'Chevron', 'COP': 'ConocoPhillips',
  'OXY': 'Occidental Petroleum', 'BP': 'BP plc', 'SHEL': 'Shell',
  'TTE': 'TotalEnergies', 'ENB': 'Enbridge',
  // Other common
  'USOIL': 'Crude Oil (WTI)', 'UKOIL': 'Brent Crude',
  '^VIX': 'VIX Volatility Index', '^TNX': '10-Year Treasury Yield',
  '^TYX': '30-Year Treasury Yield', '^IRX': '13-Week T-Bill',
  '^GSPC': 'S&P 500', '^DJI': 'Dow Jones', '^IXIC': 'Nasdaq Composite',
  '^RUT': 'Russell 2000', '^FTSE': 'FTSE 100', '^N225': 'Nikkei 225',
  '^HSI': 'Hang Seng', '^SSE': 'Shanghai Composite',
}

function instrumentName(ticker) {
  return INSTRUMENT_NAMES[ticker] || INSTRUMENT_NAMES[ticker.toUpperCase()] || null
}

function AIResult({ ai, setTvSymbol }) {
  const dirColor = ai.direction === 'bullish' ? 'var(--bullish)'
    : ai.direction === 'bearish' ? 'var(--bearish)' : 'var(--neutral)'
  const urgencyColor = ai.urgency === 'high' ? 'var(--urgency-high)'
    : ai.urgency === 'medium' ? 'var(--urgency-medium)' : 'var(--urgency-low)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Top row chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Chip label="Direction" value={ai.direction?.toUpperCase()} color={dirColor} />
        <Chip label="Action" value={ai.action?.toUpperCase()} color={dirColor} />
        <Chip label="Urgency" value={ai.urgency?.toUpperCase()} color={urgencyColor} />
        <Chip label="Timeframe" value={ai.timeframe?.toUpperCase()} color="var(--text-primary)" />
      </div>

      {/* Conviction bar */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 11 }}>
          <span style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 9 }}>
            Conviction
          </span>
          <span style={{ fontWeight: 700 }}>{ai.conviction}/10</span>
        </div>
        <div style={{ height: 4, background: 'var(--border)', borderRadius: 2 }}>
          <div style={{
            height: '100%',
            borderRadius: 2,
            width: `${(ai.conviction / 10) * 100}%`,
            background: ai.conviction >= 7 ? 'var(--bullish)'
              : ai.conviction >= 4 ? 'var(--urgency-medium)' : 'var(--bearish)',
            transition: 'width 0.4s ease',
          }} />
        </div>
      </div>

      {/* Reasoning */}
      {ai.reasoning && (
        <div style={{
          padding: '10px 12px',
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--border)',
          fontSize: 12,
          lineHeight: 1.65,
          color: 'var(--text-primary)',
        }}>
          {ai.reasoning}
        </div>
      )}

      {/* Instruments */}
      {ai.instruments_affected?.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Instruments
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {ai.instruments_affected.map((sym) => {
              const name = instrumentName(sym)
              return (
                <button
                  key={sym}
                  className="btn btn-accent"
                  style={{ fontSize: 11, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, padding: '4px 10px' }}
                  onClick={() => setTvSymbol(sym)}
                >
                  <span>{sym} ↗</span>
                  {name && <span style={{ fontSize: 9, opacity: 0.7, fontWeight: 400 }}>{name}</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Industries */}
      {ai.industries_affected?.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Industries
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {ai.industries_affected.map((ind) => (
              <span key={ind} style={{
                fontSize: 10, padding: '2px 8px',
                border: '1px solid var(--border)', color: 'var(--text-secondary)',
              }}>
                {ind}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Trade levels */}
      {(ai.suggested_entry || ai.suggested_stop || ai.suggested_target || ai.reward_risk_ratio) && (
        <div>
          <div style={{ fontSize: 9, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Suggested Levels
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {ai.suggested_entry && <Chip label="Entry" value={ai.suggested_entry} color="var(--text-primary)" />}
            {ai.suggested_stop && <Chip label="Stop" value={ai.suggested_stop} color="var(--bearish)" />}
            {ai.suggested_target && <Chip label="Target" value={ai.suggested_target} color="var(--bullish)" />}
            {ai.reward_risk_ratio && (
              <Chip
                label="R/R"
                value={`${Number(ai.reward_risk_ratio).toFixed(1)}:1`}
                color={Number(ai.reward_risk_ratio) >= 3 ? 'var(--bullish)' : 'var(--bearish)'}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Chip({ label, value, color }) {
  return (
    <div style={{
      padding: '6px 10px',
      border: '1px solid var(--border)',
      background: 'var(--bg-tertiary)',
      minWidth: 64,
    }}>
      <div style={{ fontSize: 9, color: 'var(--text-secondary)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color }}>{value ?? '—'}</div>
    </div>
  )
}
