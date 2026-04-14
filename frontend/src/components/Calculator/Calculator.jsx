import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../lib/api'
import { useApp } from '../../App'

const empty = {
  symbol: '', direction: 'long', leverage: 1,
  entry: '', margin: '', sl_price: '', sl_pct: '',
  tp_price: '', tp_pct: '',
}

export default function Calculator() {
  const { settings } = useApp()
  const minRR = parseFloat(settings.min_reward_risk || '3.0')

  const [form, setForm] = useState(empty)
  const [livePrice, setLivePrice] = useState(null)
  const [priceLoading, setPriceLoading] = useState(false)
  const [savedCalcs, setSavedCalcs] = useState([])
  const [saveName, setSaveName] = useState('')

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }))

  // Fetch live price
  const fetchPrice = useCallback(async (sym) => {
    if (!sym) return
    setPriceLoading(true)
    try {
      const { price } = await api.getPrice(sym)
      setLivePrice(price)
      set('entry', String(Number(price).toFixed(4)))
    } catch {
      setLivePrice(null)
    } finally {
      setPriceLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      if (form.symbol.length >= 2) fetchPrice(form.symbol)
    }, 600)
    return () => clearTimeout(timer)
  }, [form.symbol, fetchPrice])

  // Load saved
  useEffect(() => {
    api.getCalculations().then(setSavedCalcs).catch(() => {})
  }, [])

  // Auto-convert SL between price and %
  const handleSlPrice = (val) => {
    set('sl_price', val)
    if (val && form.entry) {
      const entry = parseFloat(form.entry)
      const sl = parseFloat(val)
      if (entry && sl) {
        const pct = form.direction === 'long'
          ? ((entry - sl) / entry) * 100
          : ((sl - entry) / entry) * 100
        set('sl_pct', pct.toFixed(2))
      }
    }
  }
  const handleSlPct = (val) => {
    set('sl_pct', val)
    if (val && form.entry) {
      const entry = parseFloat(form.entry)
      const pct = parseFloat(val)
      if (entry && pct) {
        const sl = form.direction === 'long'
          ? entry * (1 - pct / 100)
          : entry * (1 + pct / 100)
        set('sl_price', sl.toFixed(4))
      }
    }
  }
  const handleTpPrice = (val) => {
    set('tp_price', val)
    if (val && form.entry) {
      const entry = parseFloat(form.entry)
      const tp = parseFloat(val)
      if (entry && tp) {
        const pct = form.direction === 'long'
          ? ((tp - entry) / entry) * 100
          : ((entry - tp) / entry) * 100
        set('tp_pct', pct.toFixed(2))
      }
    }
  }
  const handleTpPct = (val) => {
    set('tp_pct', val)
    if (val && form.entry) {
      const entry = parseFloat(form.entry)
      const pct = parseFloat(val)
      if (entry && pct) {
        const tp = form.direction === 'long'
          ? entry * (1 + pct / 100)
          : entry * (1 - pct / 100)
        set('tp_price', tp.toFixed(4))
      }
    }
  }

  // Calculations
  const entry = parseFloat(form.entry) || 0
  const margin = parseFloat(form.margin) || 0
  const lev = parseFloat(form.leverage) || 1
  const sl = parseFloat(form.sl_price) || 0
  const tp = parseFloat(form.tp_price) || 0

  const exposure = margin * lev
  const positionSize = entry > 0 ? exposure / entry : 0

  const riskUsd = sl > 0 && entry > 0 ? Math.abs(entry - sl) * positionSize : 0
  const rewardUsd = tp > 0 && entry > 0 ? Math.abs(tp - entry) * positionSize : 0
  const riskPct = margin > 0 ? (riskUsd / margin) * 100 : 0
  const rewardPct = margin > 0 ? (rewardUsd / margin) * 100 : 0
  const rr = riskUsd > 0 ? rewardUsd / riskUsd : 0

  const liqPrice = form.direction === 'long'
    ? entry * (1 - 1 / lev)
    : entry * (1 + 1 / lev)

  const rrBad = rr > 0 && rr < minRR

  const handleSave = async () => {
    if (!saveName.trim()) return
    await api.saveCalculation(saveName.trim(), { ...form })
    const fresh = await api.getCalculations()
    setSavedCalcs(fresh)
    setSaveName('')
  }

  const handleLoad = async (e) => {
    const name = e.target.value
    if (!name) return
    const calc = savedCalcs.find((c) => c.name === name)
    if (calc) {
      try {
        setForm(JSON.parse(calc.data_json))
      } catch {}
    }
  }

  const handleDelete = async (name) => {
    await api.deleteCalculation(name)
    const fresh = await api.getCalculations()
    setSavedCalcs(fresh)
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 16 }}>
      {/* Symbol + price */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>SYMBOL</label>
          <input className="input-sig" placeholder="e.g. GOLD, AAPL, BTC-USD"
            value={form.symbol} onChange={(e) => set('symbol', e.target.value.toUpperCase())} />
        </div>
        <div style={{ textAlign: 'center', paddingTop: 18 }}>
          {priceLoading ? (
            <span className="spin" style={{ color: 'var(--accent)' }}>◌</span>
          ) : livePrice ? (
            <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 13 }}>
              {Number(livePrice).toFixed(4)}
            </span>
          ) : (
            <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>—</span>
          )}
        </div>
      </div>

      {/* Direction */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>DIRECTION</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {['long', 'short'].map((d) => (
            <button
              key={d}
              className={`btn${form.direction === d ? (d === 'long' ? ' btn-accent' : '') : ''}`}
              style={{
                flex: 1,
                borderColor: form.direction === d ? (d === 'long' ? 'var(--bullish)' : 'var(--bearish)') : undefined,
                color: form.direction === d ? (d === 'long' ? 'var(--bullish)' : 'var(--bearish)') : undefined,
              }}
              onClick={() => set('direction', d)}
            >
              {d === 'long' ? '▲ LONG' : '▼ SHORT'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div>
          <label style={labelStyle}>ENTRY PRICE</label>
          <input className="input-sig" type="number" step="any" value={form.entry}
            onChange={(e) => set('entry', e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>LEVERAGE</label>
          <select className="input-sig" value={form.leverage} onChange={(e) => set('leverage', e.target.value)}>
            {[1,2,3,5,10,15,20].map((l) => <option key={l} value={l}>{l}x</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>MARGIN / CAPITAL</label>
          <input className="input-sig" type="number" step="any" placeholder="$" value={form.margin}
            onChange={(e) => set('margin', e.target.value)} />
        </div>
      </div>

      {/* SL */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>STOP LOSS</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input-sig" type="number" step="any" placeholder="Price"
            value={form.sl_price} onChange={(e) => handleSlPrice(e.target.value)} />
          <input className="input-sig" type="number" step="any" placeholder="%" style={{ width: 80 }}
            value={form.sl_pct} onChange={(e) => handleSlPct(e.target.value)} />
        </div>
      </div>

      {/* TP */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>TARGET / TAKE PROFIT</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input-sig" type="number" step="any" placeholder="Price"
            value={form.tp_price} onChange={(e) => handleTpPrice(e.target.value)} />
          <input className="input-sig" type="number" step="any" placeholder="%" style={{ width: 80 }}
            value={form.tp_pct} onChange={(e) => handleTpPct(e.target.value)} />
        </div>
      </div>

      {/* Outputs */}
      <div style={{
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--border)',
        padding: 12,
        marginBottom: 16,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 8,
      }}>
        <Stat label="EXPOSURE" value={`$${exposure.toFixed(2)}`} />
        <Stat label="POSITION SIZE" value={positionSize.toFixed(4)} />
        <Stat label="RISK $" value={`$${riskUsd.toFixed(2)}`} color="var(--bearish)" />
        <Stat label="RISK %" value={`${riskPct.toFixed(2)}%`} color="var(--bearish)" />
        <Stat label="REWARD $" value={`$${rewardUsd.toFixed(2)}`} color="var(--bullish)" />
        <Stat label="REWARD %" value={`${rewardPct.toFixed(2)}%`} color="var(--bullish)" />
        <Stat
          label="R/R RATIO"
          value={rr > 0 ? `${rr.toFixed(2)}:1` : '—'}
          color={rrBad ? 'var(--bearish)' : rr >= minRR ? 'var(--bullish)' : 'var(--neutral)'}
          highlight={rrBad}
        />
        <Stat label="LIQUIDATION" value={liqPrice > 0 ? liqPrice.toFixed(4) : '—'} color="var(--urgency-high)" />
        <Stat label="REQ. MARGIN" value={exposure > 0 ? `$${(exposure / lev).toFixed(2)}` : '—'} />
      </div>

      {rrBad && (
        <div style={{
          padding: '6px 12px',
          background: 'rgba(255,59,59,0.1)',
          border: '1px solid var(--bearish)',
          color: 'var(--bearish)',
          fontSize: 11,
          marginBottom: 12,
        }}>
          ⚠ R/R below minimum ({minRR}:1)
        </div>
      )}

      {/* Save / Load */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input className="input-sig" placeholder="Setup name..." value={saveName}
          onChange={(e) => setSaveName(e.target.value)} />
        <button className="btn btn-accent" onClick={handleSave} style={{ flexShrink: 0 }}>SAVE</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <select className="input-sig" onChange={handleLoad} defaultValue="">
          <option value="" disabled>Load setup...</option>
          {savedCalcs.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
      </div>

      {savedCalcs.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {savedCalcs.map((c) => (
            <div key={c.name} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '4px 0', borderBottom: '1px solid var(--border)',
              fontSize: 11, color: 'var(--text-secondary)',
            }}>
              <span>{c.name}</span>
              <button className="btn btn-danger" style={{ fontSize: 9, padding: '1px 6px' }} onClick={() => handleDelete(c.name)}>✕</button>
            </div>
          ))}
        </div>
      )}

      <button className="btn" style={{ marginTop: 12, width: '100%' }} onClick={() => setForm(empty)}>
        CLEAR
      </button>
    </div>
  )
}

const labelStyle = {
  display: 'block',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'var(--text-secondary)',
  marginBottom: 4,
  textTransform: 'uppercase',
}

function Stat({ label, value, color, highlight }) {
  return (
    <div style={{
      padding: '6px 8px',
      background: highlight ? 'rgba(255,59,59,0.08)' : 'var(--bg-secondary)',
      border: highlight ? '1px solid var(--bearish)' : '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 9, color: 'var(--text-secondary)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: color || 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  )
}
