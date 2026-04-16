import React, { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../App'
import { applyTheme } from '../lib/theme'

const DEFAULT_SOURCES = [
  { name: 'Reuters', url: 'https://feeds.reuters.com/reuters/topNews', category: 'general', enabled: true },
  { name: 'AP News', url: 'https://rsshub.app/apnews/topics/apf-topnews', category: 'general', enabled: true },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'geopolitical', enabled: true },
  { name: 'CNBC Energy', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19836768', category: 'energy', enabled: true },
  { name: 'Bloomberg Markets', url: 'https://feeds.bloomberg.com/markets/news.rss', category: 'markets', enabled: true },
]

export default function Settings() {
  const { settings: ctxSettings, updateSettings } = useApp()
  const [local, setLocal] = useState({})
  const [sources, setSources] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testResults, setTestResults] = useState({})

  useEffect(() => {
    api.getSettings().then((s) => setLocal(s)).catch(() => {})
    api.getSources().then((s) => setSources(s)).catch(() => {})
  }, [])

  const set = (key, val) => {
    setLocal((prev) => {
      const next = { ...prev, [key]: val }
      // Live-apply theme changes
      applyTheme(next)
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      // Strip masked API key — backend already has the real value, sending "***" would overwrite it
      const payload = { ...local }
      if (payload.anthropic_api_key === '***') delete payload.anthropic_api_key
      await updateSettings(payload)
      await api.saveSources(sources)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      alert(e.message)
    } finally {
      setSaving(false)
    }
  }

  const testSource = async (source, idx) => {
    try {
      const result = await api.testSource(source)
      setTestResults((prev) => ({ ...prev, [idx]: result.headlines || [] }))
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [idx]: [e.message] }))
    }
  }

  const addSource = () => {
    setSources((prev) => [...prev, { name: '', url: '', category: 'general', enabled: true }])
  }

  const updateSource = (idx, key, val) => {
    setSources((prev) => prev.map((s, i) => i === idx ? { ...s, [key]: val } : s))
  }

  const removeSource = (idx) => {
    setSources((prev) => prev.filter((_, i) => i !== idx))
  }

  const exportData = async () => {
    try {
      const res = await api.exportData()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'signal_export.csv'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert(e.message)
    }
  }

  return (
    <div style={{ width: '100vw', height: 'calc(100vh - 42px)', overflowY: 'auto', padding: 24 }}>
      <div style={{ maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 24 }}>

        {/* Save bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--accent)' }}>SETTINGS</h1>
          <button className="btn btn-accent" onClick={save} disabled={saving}>
            {saving ? 'SAVING...' : saved ? '✓ SAVED' : 'SAVE ALL'}
          </button>
        </div>

        {/* AI Settings */}
        <Section title="AI SETTINGS">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Label>ANTHROPIC API KEY</Label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="input-sig" type="password"
                  placeholder={local.anthropic_api_key === '***' ? '● ● ● ● ● ● ● ● (key saved — leave blank to keep)' : 'sk-ant-...'}
                  value={local.anthropic_api_key === '***' ? '' : (local.anthropic_api_key || '')}
                  onChange={(e) => set('anthropic_api_key', e.target.value || '***')}
                  style={{ flex: 1 }}
                />
                {local.anthropic_api_key === '***' && (
                  <span style={{ color: 'var(--bullish)', fontSize: 10, whiteSpace: 'nowrap' }}>✓ SAVED</span>
                )}
              </div>
            </div>
            <div>
              <Label>CLAUDE MODEL</Label>
              <select className="input-sig" value={local.claude_model || ''}
                onChange={(e) => set('claude_model', e.target.value)}>
                <option value="claude-sonnet-4-6">claude-sonnet-4-6 (recommended)</option>
                <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001 (fast, cheap)</option>
                <option value="claude-opus-4-6">claude-opus-4-6 (slow, expensive)</option>
              </select>
            </div>
            <div>
              <Label>MAX TOKENS</Label>
              <input className="input-sig" type="number" value={local.max_tokens || ''}
                onChange={(e) => set('max_tokens', e.target.value)} />
            </div>
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 24, alignItems: 'center', padding: '8px 0' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={local.auto_analyze === 'true'}
                  onChange={(e) => set('auto_analyze', e.target.checked ? 'true' : 'false')}
                />
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>AUTO-ANALYZE ARTICLES</div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                    Analyze each new article as it's fetched (up to 15/cycle). Required for Globe arcs and route signals. Uses API credits.
                  </div>
                </div>
              </label>
            </div>
            <div>
              <Label>CONVICTION THRESHOLD (hide below)</Label>
              <input className="input-sig" type="number" min="1" max="10" value={local.conviction_threshold || ''}
                onChange={(e) => set('conviction_threshold', e.target.value)} />
            </div>
            <div>
              <Label>MIN REWARD/RISK RATIO</Label>
              <input className="input-sig" type="number" step="0.1" value={local.min_reward_risk || ''}
                onChange={(e) => set('min_reward_risk', e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <Label>ARTICLE ANALYSIS SYSTEM PROMPT</Label>
            <textarea className="input-sig" rows={8}
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
              value={local.article_system_prompt || ''}
              onChange={(e) => set('article_system_prompt', e.target.value)} />
          </div>
          <div style={{ marginTop: 12 }}>
            <Label>DAILY DIGEST SYSTEM PROMPT</Label>
            <textarea className="input-sig" rows={8}
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
              value={local.digest_system_prompt || ''}
              onChange={(e) => set('digest_system_prompt', e.target.value)} />
          </div>
        </Section>

        {/* Digest Schedule */}
        <Section title="DAILY DIGEST SCHEDULE">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div>
              <Label>TIMEZONE</Label>
              <select className="input-sig" value={local.timezone || 'Asia/Dubai'}
                onChange={(e) => set('timezone', e.target.value)}>
                {['Asia/Dubai', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Asia/Singapore'].map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
            <div>
              <Label>MORNING RUN TIME</Label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="input-sig" type="time" value={local.digest_morning_time || '08:00'}
                  onChange={(e) => set('digest_morning_time', e.target.value)} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11 }}>
                  <input type="checkbox" checked={local.digest_morning_enabled === 'true'}
                    onChange={(e) => set('digest_morning_enabled', e.target.checked ? 'true' : 'false')} />
                  ON
                </label>
              </div>
            </div>
            <div>
              <Label>AFTERNOON RUN TIME</Label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="input-sig" type="time" value={local.digest_afternoon_time || '17:00'}
                  onChange={(e) => set('digest_afternoon_time', e.target.value)} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11 }}>
                  <input type="checkbox" checked={local.digest_afternoon_enabled === 'true'}
                    onChange={(e) => set('digest_afternoon_enabled', e.target.checked ? 'true' : 'false')} />
                  ON
                </label>
              </div>
            </div>
          </div>
        </Section>

        {/* News Sources */}
        <Section title="NEWS SOURCES">
          <div style={{ marginBottom: 8 }}>
            <Label>FETCH INTERVAL (seconds)</Label>
            <input className="input-sig" type="number" style={{ width: 120 }}
              value={local.fetch_interval_seconds || ''}
              onChange={(e) => set('fetch_interval_seconds', e.target.value)} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sources.map((source, idx) => (
              <div key={idx} style={{
                padding: 10,
                border: '1px solid var(--border)',
                background: 'var(--bg-tertiary)',
              }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 120px auto', gap: 8, marginBottom: 6 }}>
                  <input className="input-sig" placeholder="Name" value={source.name}
                    onChange={(e) => updateSource(idx, 'name', e.target.value)} />
                  <input className="input-sig" placeholder="RSS URL" value={source.url}
                    onChange={(e) => updateSource(idx, 'url', e.target.value)} />
                  <select className="input-sig" value={source.category}
                    onChange={(e) => updateSource(idx, 'category', e.target.value)}>
                    {['general', 'energy', 'markets', 'geopolitical', 'metals', 'crypto'].map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11 }}>
                      <input type="checkbox" checked={source.enabled !== false}
                        onChange={(e) => updateSource(idx, 'enabled', e.target.checked)} />
                      ON
                    </label>
                    <button className="btn" style={{ fontSize: 10 }} onClick={() => testSource(source, idx)}>TEST</button>
                    <button className="btn btn-danger" style={{ fontSize: 10 }} onClick={() => removeSource(idx)}>✕</button>
                  </div>
                </div>
                {testResults[idx] && (
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '4px 0' }}>
                    {testResults[idx].length === 0
                      ? 'No headlines found.'
                      : testResults[idx].map((h, i) => <div key={i}>• {h}</div>)}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-accent" onClick={addSource}>+ ADD SOURCE</button>
            <button className="btn" onClick={() => setSources(DEFAULT_SOURCES)}>
              RESTORE DEFAULTS
            </button>
          </div>
        </Section>

        {/* Theme */}
        <Section title="THEME & DISPLAY">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
            {[
              ['color_bg_primary', 'Background Primary'],
              ['color_bg_secondary', 'Background Secondary'],
              ['color_bg_tertiary', 'Background Tertiary'],
              ['color_accent', 'Accent'],
              ['color_text_primary', 'Text Primary'],
              ['color_text_secondary', 'Text Secondary'],
              ['color_border', 'Border'],
              ['color_bullish', 'Bullish'],
              ['color_bearish', 'Bearish'],
              ['color_neutral', 'Neutral'],
              ['color_urgency_high', 'High Urgency'],
            ].map(([key, label]) => (
              <ColorPicker key={key} label={label} value={local[key] || '#000000'}
                onChange={(v) => set(key, v)} />
            ))}
          </div>

          <div style={{ marginBottom: 12 }}>
            <Label>FONT</Label>
            <select className="input-sig" style={{ width: 200 }} value={local.font_family || 'monospace'}
              onChange={(e) => set('font_family', e.target.value)}>
              <option value="monospace">Monospace</option>
              <option value="sans-serif">Sans-serif</option>
              <option value="serif">Serif</option>
            </select>
          </div>

          {/* Live preview */}
          <div style={{
            padding: 12,
            border: '1px solid var(--border)',
            background: 'var(--bg-tertiary)',
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
          }}>
            {[
              ['BG PRIMARY', 'var(--bg-primary)'],
              ['BG SECONDARY', 'var(--bg-secondary)'],
              ['ACCENT', 'var(--accent)'],
              ['BULLISH', 'var(--bullish)'],
              ['BEARISH', 'var(--bearish)'],
              ['NEUTRAL', 'var(--neutral)'],
              ['HIGH URGENCY', 'var(--urgency-high)'],
            ].map(([label, color]) => (
              <div key={label} style={{ textAlign: 'center' }}>
                <div style={{ width: 40, height: 40, background: color, border: '1px solid var(--border)', marginBottom: 4 }} />
                <div style={{ fontSize: 9, color: 'var(--text-secondary)' }}>{label}</div>
              </div>
            ))}
          </div>

          <button className="btn" style={{ marginTop: 12 }} onClick={() => {
            const defaults = {
              color_bg_primary: '#0a0a0f', color_bg_secondary: '#111118',
              color_bg_tertiary: '#1a1a24',
              color_accent: '#00d4ff', color_text_primary: '#e8e8f0',
              color_text_secondary: '#888899', color_border: '#1e1e2e',
              color_bullish: '#00ff88', color_bearish: '#ff3b3b',
              color_neutral: '#888888', color_urgency_high: '#ff6b00',
            }
            setLocal((prev) => ({ ...prev, ...defaults }))
            applyTheme(defaults)
          }}>
            RESET TO DEFAULTS
          </button>
        </Section>

        {/* Globe Colors */}
        <Section title="GLOBE COLORS">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {[
              ['color_globe_news_bullish', 'News — Bullish'],
              ['color_globe_news_bearish', 'News — Bearish'],
              ['color_globe_news_neutral', 'News — Neutral'],
              ['color_globe_route_no_signal', 'Route — No Signal'],
              ['color_globe_route_normal', 'Route — Normal'],
              ['color_globe_route_elevated', 'Route — Elevated'],
              ['color_globe_route_high_risk', 'Route — High Risk'],
              ['color_globe_arc_geo', 'Arc — Geo Connection'],
            ].map(([key, label]) => (
              <ColorPicker key={key} label={label} value={local[key] || '#000000'}
                onChange={(v) => set(key, v)} />
            ))}
          </div>
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              className="btn"
              onClick={async () => {
                try {
                  await api.refreshInfrastructure()
                  alert('Infrastructure refresh started. Data will update in the background (~10 min).')
                } catch (e) {
                  alert('Refresh failed: ' + e.message)
                }
              }}
            >
              REFRESH INFRASTRUCTURE DATA
            </button>
            <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
              Re-fetches energy, mining & agriculture sites from OpenStreetMap
            </span>
          </div>
        </Section>

        {/* TradingView */}
        <Section title="TRADINGVIEW">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div>
              <Label>DEFAULT SYMBOL</Label>
              <input className="input-sig" placeholder="e.g. OANDA:XAUUSD"
                value={local.tradingview_default_symbol || ''}
                onChange={(e) => set('tradingview_default_symbol', e.target.value)} />
            </div>
            <div>
              <Label>DEFAULT INTERVAL</Label>
              <select className="input-sig" value={local.tradingview_default_interval || 'D'}
                onChange={(e) => set('tradingview_default_interval', e.target.value)}>
                {[['1', '1m'], ['5', '5m'], ['15', '15m'], ['60', '1h'], ['240', '4h'], ['D', '1D'], ['W', '1W']]
                  .map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label>CHART THEME</Label>
              <select className="input-sig" value={local.tradingview_theme || 'dark'}
                onChange={(e) => set('tradingview_theme', e.target.value)}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>
          </div>
        </Section>

        {/* Data */}
        <Section title="DATA MANAGEMENT">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <Label>ARTICLE RETENTION (days)</Label>
              <input className="input-sig" type="number" style={{ width: 100 }}
                value={local.retention_days || ''}
                onChange={(e) => set('retention_days', e.target.value)} />
            </div>
            <div style={{ paddingTop: 18 }}>
              <button className="btn" onClick={exportData}>↓ EXPORT CSV</button>
            </div>
            <div style={{ paddingTop: 18 }}>
              <button className="btn btn-danger" onClick={async () => {
                if (confirm('Clear old articles now?')) await api.purgeData()
              }}>
                CLEAR OLD DATA
              </button>
            </div>
          </div>
        </Section>

      </div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.1em',
        color: 'var(--accent)',
      }}>
        {title}
      </div>
      <div style={{ padding: '16px' }}>
        {children}
      </div>
    </div>
  )
}

function Label({ children }) {
  return (
    <div style={{
      fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
      color: 'var(--text-secondary)', marginBottom: 4, textTransform: 'uppercase',
    }}>
      {children}
    </div>
  )
}

function ColorPicker({ label, value, onChange }) {
  return (
    <div>
      <Label>{label}</Label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 36, height: 30, padding: 2,
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border)',
            cursor: 'pointer',
          }}
        />
        <input
          className="input-sig"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 100 }}
          maxLength={7}
        />
      </div>
    </div>
  )
}
