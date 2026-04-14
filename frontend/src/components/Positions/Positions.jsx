import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../../lib/api'

const emptyForm = {
  instrument: '', direction: 'long', entry_price: '', size: '',
  stop_loss: '', take_profit: '', open_date: '', notes: '',
}

export default function Positions() {
  const [positions, setPositions] = useState([])
  const [prices, setPrices] = useState({})
  const [form, setForm] = useState(emptyForm)
  const [editId, setEditId] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    const data = await api.getPositions()
    setPositions(data)
    // Fetch prices for all instruments
    const symbols = [...new Set(data.map((p) => p.instrument).filter(Boolean))]
    symbols.forEach(async (sym) => {
      try {
        const { price } = await api.getPrice(sym)
        setPrices((prev) => ({ ...prev, [sym]: price }))
      } catch {}
    })
  }, [])

  useEffect(() => { load() }, [load])

  // Auto-refresh prices every 30s
  useEffect(() => {
    const id = setInterval(() => {
      positions.forEach(async (p) => {
        if (!p.instrument) return
        try {
          const { price } = await api.getPrice(p.instrument)
          setPrices((prev) => ({ ...prev, [p.instrument]: price }))
        } catch {}
      })
    }, 30000)
    return () => clearInterval(id)
  }, [positions])

  const calcPL = (pos) => {
    const current = prices[pos.instrument]
    if (!current || !pos.entry_price || !pos.size) return null
    const diff = pos.direction === 'long'
      ? (current - pos.entry_price) * pos.size
      : (pos.entry_price - current) * pos.size
    return diff
  }

  const totalPL = positions.reduce((sum, p) => {
    const pl = calcPL(p)
    return pl !== null ? sum + pl : sum
  }, 0)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      const data = {
        ...form,
        entry_price: parseFloat(form.entry_price) || 0,
        size: parseFloat(form.size) || 0,
        stop_loss: form.stop_loss ? parseFloat(form.stop_loss) : null,
        take_profit: form.take_profit ? parseFloat(form.take_profit) : null,
      }
      if (editId) {
        await api.updatePosition(editId, data)
      } else {
        await api.createPosition(data)
      }
      setForm(emptyForm)
      setEditId(null)
      setShowForm(false)
      await load()
    } catch (e) {
      alert(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete position?')) return
    await api.deletePosition(id)
    await load()
  }

  const handleEdit = (pos) => {
    setForm({
      instrument: pos.instrument || '',
      direction: pos.direction || 'long',
      entry_price: pos.entry_price || '',
      size: pos.size || '',
      stop_loss: pos.stop_loss || '',
      take_profit: pos.take_profit || '',
      open_date: pos.open_date || '',
      notes: pos.notes || '',
    })
    setEditId(pos.id)
    setShowForm(true)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Total P/L bar */}
      <div style={{
        padding: '8px 16px',
        background: 'var(--bg-tertiary)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', letterSpacing: '0.08em' }}>PORTFOLIO P/L</span>
        <span style={{
          fontSize: 16,
          fontWeight: 700,
          color: totalPL >= 0 ? 'var(--bullish)' : 'var(--bearish)',
        }}>
          {totalPL >= 0 ? '+' : ''}{totalPL.toFixed(2)}
        </span>
        <button className="btn btn-accent" style={{ fontSize: 10 }} onClick={() => { setShowForm(true); setEditId(null); setForm(emptyForm) }}>
          + ADD
        </button>
      </div>

      {/* Add/Edit form */}
      {showForm && (
        <form onSubmit={handleSubmit} style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
            <input className="input-sig" placeholder="Instrument (e.g. AAPL)" value={form.instrument}
              onChange={(e) => setForm((f) => ({ ...f, instrument: e.target.value }))} required />
            <select className="input-sig" value={form.direction}
              onChange={(e) => setForm((f) => ({ ...f, direction: e.target.value }))}>
              <option value="long">LONG</option>
              <option value="short">SHORT</option>
            </select>
            <input className="input-sig" placeholder="Entry Price" type="number" step="any" value={form.entry_price}
              onChange={(e) => setForm((f) => ({ ...f, entry_price: e.target.value }))} required />
            <input className="input-sig" placeholder="Size / Qty" type="number" step="any" value={form.size}
              onChange={(e) => setForm((f) => ({ ...f, size: e.target.value }))} required />
            <input className="input-sig" placeholder="Stop Loss" type="number" step="any" value={form.stop_loss}
              onChange={(e) => setForm((f) => ({ ...f, stop_loss: e.target.value }))} />
            <input className="input-sig" placeholder="Take Profit" type="number" step="any" value={form.take_profit}
              onChange={(e) => setForm((f) => ({ ...f, take_profit: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-accent" type="submit" disabled={loading} style={{ flex: 1 }}>
              {editId ? 'UPDATE' : 'ADD POSITION'}
            </button>
            <button className="btn" type="button" onClick={() => { setShowForm(false); setEditId(null) }}>
              CANCEL
            </button>
          </div>
        </form>
      )}

      {/* Positions list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {positions.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 12 }}>
            No open positions. Click ADD to track a trade.
          </div>
        )}

        {positions.map((pos) => {
          const pl = calcPL(pos)
          const current = prices[pos.instrument]
          const plPct = pl !== null && pos.entry_price
            ? (pl / (pos.entry_price * pos.size)) * 100
            : null

          return (
            <div key={pos.id} style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--border)',
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: 8,
            }}>
              <div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{pos.instrument}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 700,
                    color: pos.direction === 'long' ? 'var(--bullish)' : 'var(--bearish)',
                  }}>
                    {pos.direction.toUpperCase()}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-secondary)' }}>
                  <span>Entry: <strong style={{ color: 'var(--text-primary)' }}>{pos.entry_price}</strong></span>
                  {current && <span>Now: <strong style={{ color: 'var(--text-primary)' }}>{Number(current).toFixed(4)}</strong></span>}
                  <span>Qty: {pos.size}</span>
                </div>
                {(pos.stop_loss || pos.take_profit) && (
                  <div style={{ display: 'flex', gap: 12, fontSize: 10, marginTop: 2, color: 'var(--text-secondary)' }}>
                    {pos.stop_loss && <span style={{ color: 'var(--bearish)' }}>SL: {pos.stop_loss}</span>}
                    {pos.take_profit && <span style={{ color: 'var(--bullish)' }}>TP: {pos.take_profit}</span>}
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4 }}>
                {pl !== null ? (
                  <>
                    <span style={{
                      fontSize: 14, fontWeight: 700,
                      color: pl >= 0 ? 'var(--bullish)' : 'var(--bearish)',
                    }}>
                      {pl >= 0 ? '+' : ''}{pl.toFixed(2)}
                    </span>
                    <span style={{
                      fontSize: 10,
                      color: pl >= 0 ? 'var(--bullish)' : 'var(--bearish)',
                    }}>
                      {plPct >= 0 ? '+' : ''}{plPct?.toFixed(2)}%
                    </span>
                  </>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>No price</span>
                )}
                <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                  <button className="btn" style={{ fontSize: 9, padding: '2px 6px' }} onClick={() => handleEdit(pos)}>EDIT</button>
                  <button className="btn btn-danger" style={{ fontSize: 9, padding: '2px 6px' }} onClick={() => handleDelete(pos.id)}>✕</button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
