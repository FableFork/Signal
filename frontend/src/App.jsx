import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import { api } from './lib/api'
import { applyTheme } from './lib/theme'
import Dashboard from './pages/Dashboard'
import Daily from './pages/Daily'
import Settings from './pages/Settings'
import Globe from './pages/Globe'

// ─── Global Context ───────────────────────────────────────────────────────────
export const AppContext = createContext(null)
export function useApp() { return useContext(AppContext) }

// ─── WebSocket hook ───────────────────────────────────────────────────────────
function useWebSocket(onMessage) {
  const ws = useRef(null)
  const [connected, setConnected] = useState(false)
  const onMessageRef = useRef(onMessage)
  useEffect(() => { onMessageRef.current = onMessage }, [onMessage])

  useEffect(() => {
    let active = true

    function connect() {
      if (!active) return
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const url = `${protocol}://${window.location.host}/ws`
      const socket = new WebSocket(url)
      socket.onopen = () => { if (active) setConnected(true) }
      socket.onmessage = (e) => {
        try { onMessageRef.current(JSON.parse(e.data)) } catch {}
      }
      socket.onclose = () => {
        if (active) {
          setConnected(false)
          setTimeout(connect, 3000)
        }
      }
      socket.onerror = () => socket.close()
      ws.current = socket
    }

    connect()
    return () => {
      active = false
      ws.current?.close()
    }
  }, [])

  return connected
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState('dashboard')
  const [settings, setSettings] = useState({})
  const [unreadCount, setUnreadCount] = useState(0)
  const [tvSymbol, setTvSymbol] = useState('')
  const [tvInterval, setTvInterval] = useState('D')
  const [selectedArticle, setSelectedArticle] = useState(null)
  const articleListeners = useRef([])

  // Load settings on mount
  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s)
      applyTheme(s)
      setTvSymbol(s.tradingview_default_symbol || '')
      setTvInterval(s.tradingview_default_interval || 'D')
    }).catch(() => {})
  }, [])

  const refreshUnread = useCallback(async () => {
    try {
      const { count } = await api.unreadCount()
      setUnreadCount(count)
    } catch {}
  }, [])

  useEffect(() => { refreshUnread() }, [refreshUnread])

  const handleWsMessage = useCallback((msg) => {
    if (msg.type === 'new_article') {
      setUnreadCount((c) => c + 1)
      articleListeners.current.forEach((fn) => fn(msg.article))
    }
  }, [])

  const connected = useWebSocket(handleWsMessage)

  const updateSettings = useCallback(async (patch) => {
    await api.updateSettings(patch)
    const fresh = await api.getSettings()
    setSettings(fresh)
    applyTheme(fresh)
  }, [])

  const onNewArticle = useCallback((fn) => {
    articleListeners.current.push(fn)
  }, [])

  const offNewArticle = useCallback((fn) => {
    articleListeners.current = articleListeners.current.filter((f) => f !== fn)
  }, [])

  const ctx = {
    settings, updateSettings,
    unreadCount, refreshUnread,
    tvSymbol, setTvSymbol,
    tvInterval, setTvInterval,
    wsConnected: connected,
    onNewArticle, offNewArticle,
    tab, setTab,
    selectedArticle, setSelectedArticle,
  }

  return (
    <AppContext.Provider value={ctx}>
      <div style={{ width: '100vw', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <NavBar tab={tab} setTab={setTab} connected={connected} unreadCount={unreadCount} />
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {tab === 'dashboard' && <Dashboard />}
          {tab === 'daily' && <Daily />}
          {tab === 'globe' && <Globe />}
          {tab === 'settings' && <Settings />}
        </div>
      </div>
    </AppContext.Provider>
  )
}

function NavBar({ tab, setTab, connected, unreadCount }) {
  const tabs = [
    { id: 'dashboard', label: 'DASHBOARD' },
    { id: 'daily', label: 'DAILY' },
    { id: 'globe', label: '◉ GLOBE' },
    { id: 'settings', label: 'SETTINGS' },
  ]

  return (
    <nav style={{
      display: 'flex',
      alignItems: 'center',
      padding: '0 20px',
      height: 42,
      background: 'var(--bg-secondary)',
      borderBottom: '1px solid var(--border)',
      flexShrink: 0,
      gap: 2,
    }}>
      <span style={{
        fontSize: 14,
        fontWeight: 700,
        letterSpacing: '0.2em',
        color: 'var(--accent)',
        marginRight: 24,
      }}>
        ▲ SIGNAL
      </span>

      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          style={{
            padding: '0 16px',
            height: 42,
            background: 'none',
            border: 'none',
            borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
            color: tab === t.id ? 'var(--accent)' : 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.1em',
            fontFamily: 'inherit',
            transition: 'all 0.15s',
            position: 'relative',
          }}
        >
          {t.label}
          {t.id === 'dashboard' && unreadCount > 0 && (
            <span style={{
              position: 'absolute',
              top: 6,
              right: 2,
              background: 'var(--accent)',
              color: 'var(--bg-primary)',
              borderRadius: 10,
              fontSize: 9,
              padding: '1px 5px',
              fontWeight: 700,
              lineHeight: 1.4,
            }}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      ))}

      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div
          className={connected ? 'pulse' : ''}
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: connected ? 'var(--bullish)' : 'var(--bearish)',
          }}
        />
        <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
          {connected ? 'LIVE' : 'OFFLINE'}
        </span>
      </div>
    </nav>
  )
}
