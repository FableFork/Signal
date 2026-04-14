import React, { useState } from 'react'
import SignalFeed from '../components/SignalFeed/SignalFeed'
import CenterPanel from '../components/Positions/CenterPanel'
import DailyPreview from '../components/Daily/DailyPreview'
import TradingViewPanel from '../components/TradingView/TradingViewPanel'

export default function Dashboard() {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '360px 1fr 420px',
      gridTemplateRows: '1fr',
      height: 'calc(100vh - 42px)',
      width: '100vw',
      overflow: 'hidden',
    }}>
      {/* Left — Signal Feed */}
      <div style={{ borderRight: '1px solid var(--border)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <SignalFeed />
      </div>

      {/* Center — Positions/Calculator + Daily Preview */}
      <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
          <CenterPanel />
        </div>
        <div style={{ borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <DailyPreview />
        </div>
      </div>

      {/* Right — TradingView */}
      <div style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <TradingViewPanel />
      </div>
    </div>
  )
}
