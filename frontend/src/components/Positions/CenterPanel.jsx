import React, { useState, useEffect } from 'react'
import { useApp } from '../../App'
import Positions from './Positions'
import Calculator from '../Calculator/Calculator'
import ArticleReader from '../SignalFeed/ArticleReader'

export default function CenterPanel() {
  const [tab, setTab] = useState('reader')
  const { selectedArticle } = useApp()

  // Auto-switch to reader when an article is selected
  useEffect(() => {
    if (selectedArticle) setTab('reader')
  }, [selectedArticle])

  const tabs = ['reader', 'positions', 'calculator']

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0,
      }}>
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 20px',
              background: 'none',
              border: 'none',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t ? 'var(--accent)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Panel */}
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {tab === 'reader' && <ArticleReader />}
        {tab === 'positions' && <Positions />}
        {tab === 'calculator' && <Calculator />}
      </div>
    </div>
  )
}
