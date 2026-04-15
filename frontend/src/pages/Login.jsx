import React, { useState } from 'react'
import { api, setToken } from '../lib/api'

export default function Login({ onAuth, isFirstRun }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError(null)

    if (isFirstRun) {
      if (!username.trim() || !password) return setError('Username and password required')
      if (password !== confirm) return setError('Passwords do not match')
      if (password.length < 6) return setError('Password must be at least 6 characters')
    }

    setLoading(true)
    try {
      const result = isFirstRun
        ? await api.register(username.trim(), password)
        : await api.login(username.trim(), password)
      setToken(result.token)
      onAuth(result.user)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      width: '100vw', height: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-primary)',
      fontFamily: 'var(--font-family, monospace)',
    }}>
      <div style={{ width: 340 }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '0.3em', color: 'var(--accent)' }}>
            ▲ SIGNAL
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6, letterSpacing: '0.15em' }}>
            {isFirstRun ? 'CREATE ACCOUNT' : 'SIGN IN'}
          </div>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Username
            </div>
            <input
              className="input-sig"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
              autoComplete="username"
            />
          </div>

          <div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Password
            </div>
            <input
              className="input-sig"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete={isFirstRun ? 'new-password' : 'current-password'}
            />
          </div>

          {isFirstRun && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Confirm Password
              </div>
              <input
                className="input-sig"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </div>
          )}

          {error && (
            <div style={{
              padding: '8px 12px',
              background: 'rgba(255,59,59,0.1)',
              border: '1px solid var(--bearish)',
              color: 'var(--bearish)',
              fontSize: 11,
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-accent"
            style={{ marginTop: 4, padding: '10px', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em' }}
            disabled={loading}
          >
            {loading
              ? <><span className="spin">◌</span> {isFirstRun ? 'Creating...' : 'Signing in...'}</>
              : isFirstRun ? 'CREATE ACCOUNT' : 'SIGN IN'
            }
          </button>
        </form>
      </div>
    </div>
  )
}
