import React, { useState, useRef, useCallback } from 'react'
import SignalFeed from '../components/SignalFeed/SignalFeed'
import CenterPanel from '../components/Positions/CenterPanel'
import DailyPreview from '../components/Daily/DailyPreview'
import TradingViewPanel from '../components/TradingView/TradingViewPanel'

const HANDLE_SIZE = 4

function useColResize(initial) {
  const [width, setWidth] = useState(initial)
  const startRef = useRef(null)

  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    startRef.current = { x: e.clientX, w: width }

    const onMove = (e) => {
      if (!startRef.current) return
      const dx = e.clientX - startRef.current.x
      setWidth(Math.max(180, Math.min(720, startRef.current.w + dx)))
    }
    const onUp = () => {
      startRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [width])

  return [width, onMouseDown]
}

function useRightColResize(initial) {
  const [width, setWidth] = useState(initial)
  const startRef = useRef(null)

  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    startRef.current = { x: e.clientX, w: width }

    const onMove = (e) => {
      if (!startRef.current) return
      const dx = e.clientX - startRef.current.x
      // dragging the handle left → right col grows
      setWidth(Math.max(220, Math.min(800, startRef.current.w - dx)))
    }
    const onUp = () => {
      startRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [width])

  return [width, onMouseDown]
}

function useRowResize(initial) {
  const [height, setHeight] = useState(initial)
  const startRef = useRef(null)

  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    startRef.current = { y: e.clientY, h: height }

    const onMove = (e) => {
      if (!startRef.current) return
      const dy = e.clientY - startRef.current.y
      // dragging down shrinks daily, up grows it
      setHeight(Math.max(48, Math.min(600, startRef.current.h - dy)))
    }
    const onUp = () => {
      startRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [height])

  return [height, onMouseDown]
}

// ─── Drag handle components ───────────────────────────────────────────────────

function ColHandle({ onMouseDown }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: HANDLE_SIZE,
        cursor: 'col-resize',
        background: hover ? 'var(--accent)' : 'var(--border)',
        flexShrink: 0,
        transition: 'background 0.15s',
        zIndex: 10,
      }}
    />
  )
}

function RowHandle({ onMouseDown }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: HANDLE_SIZE,
        cursor: 'row-resize',
        background: hover ? 'var(--accent)' : 'var(--border)',
        flexShrink: 0,
        transition: 'background 0.15s',
        zIndex: 10,
      }}
    />
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [leftWidth, onLeftHandleDown] = useColResize(300)
  const [rightWidth, onRightHandleDown] = useRightColResize(420)
  const [dailyHeight, onDailyHandleDown] = useRowResize(160)

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      height: 'calc(100vh - 42px)',
      width: '100vw',
      overflow: 'hidden',
      userSelect: 'none',
    }}>
      {/* Left — Signal Feed */}
      <div style={{ width: leftWidth, flexShrink: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <SignalFeed />
      </div>

      <ColHandle onMouseDown={onLeftHandleDown} />

      {/* Center — Reader/Positions/Calculator + Daily Brief */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
          <CenterPanel />
        </div>
        <RowHandle onMouseDown={onDailyHandleDown} />
        <div style={{ height: dailyHeight, flexShrink: 0, overflow: 'hidden' }}>
          <DailyPreview />
        </div>
      </div>

      <ColHandle onMouseDown={onRightHandleDown} />

      {/* Right — TradingView */}
      <div style={{ width: rightWidth, flexShrink: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <TradingViewPanel />
      </div>
    </div>
  )
}
