import React, { useEffect, useRef, useState } from 'react'
import { useApp } from '../../App'

const INTERVALS = ['1', '5', '15', '60', '240', 'D', 'W']
const INTERVAL_LABELS = { '1': '1m', '5': '5m', '15': '15m', '60': '1h', '240': '4h', 'D': '1D', 'W': '1W' }

export default function TradingViewPanel() {
  const { tvSymbol, setTvSymbol, tvInterval, setTvInterval, settings } = useApp()
  const containerRef = useRef(null)
  const widgetRef = useRef(null)
  const [inputSymbol, setInputSymbol] = useState(tvSymbol || '')

  // Sync input when external symbol changes
  useEffect(() => {
    setInputSymbol(tvSymbol || '')
  }, [tvSymbol])

  useEffect(() => {
    if (!containerRef.current) return
    containerRef.current.innerHTML = ''

    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/tv.js'
    script.async = true
    script.onload = () => {
      if (!window.TradingView) return
      widgetRef.current = new window.TradingView.widget({
        container_id: 'tv-container',
        autosize: true,
        symbol: tvSymbol || 'OANDA:XAUUSD',
        interval: tvInterval || 'D',
        theme: settings.tradingview_theme || 'dark',
        style: '1',
        locale: 'en',
        toolbar_bg: 'var(--bg-secondary)',
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_legend: false,
        save_image: false,
      })
    }
    containerRef.current.appendChild(script)

    return () => {
      if (containerRef.current) containerRef.current.innerHTML = ''
    }
  }, [tvSymbol, tvInterval, settings.tradingview_theme])

  const applySymbol = () => {
    if (inputSymbol.trim()) setTvSymbol(inputSymbol.trim().toUpperCase())
  }

  const openFullTV = () => {
    const sym = tvSymbol || 'OANDA:XAUUSD'
    window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`, '_blank')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Controls */}
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <input
          className="input-sig"
          style={{ flex: 1 }}
          placeholder="Symbol..."
          value={inputSymbol}
          onChange={(e) => setInputSymbol(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') applySymbol() }}
        />
        <button className="btn btn-accent" style={{ fontSize: 10 }} onClick={applySymbol}>GO</button>
        <button className="btn" style={{ fontSize: 10 }} onClick={openFullTV}>↗</button>
      </div>

      {/* Interval selector */}
      <div style={{
        display: 'flex',
        gap: 1,
        padding: '6px 12px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0,
      }}>
        {INTERVALS.map((iv) => (
          <button
            key={iv}
            onClick={() => setTvInterval(iv)}
            style={{
              padding: '3px 8px',
              background: tvInterval === iv ? 'var(--accent-dim)' : 'none',
              border: '1px solid',
              borderColor: tvInterval === iv ? 'var(--accent)' : 'var(--border)',
              color: tvInterval === iv ? 'var(--accent)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 10,
              fontWeight: 700,
              fontFamily: 'inherit',
              transition: 'all 0.1s',
            }}
          >
            {INTERVAL_LABELS[iv]}
          </button>
        ))}
      </div>

      {/* Chart container */}
      <div
        id="tv-container"
        ref={containerRef}
        style={{ flex: 1, overflow: 'hidden' }}
      />
    </div>
  )
}
