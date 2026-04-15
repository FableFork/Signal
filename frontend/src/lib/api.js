const BASE = '/api'

function getToken() {
  return localStorage.getItem('signal_token')
}

export function setToken(token) {
  if (token) localStorage.setItem('signal_token', token)
  else localStorage.removeItem('signal_token')
}

async function req(path, opts = {}) {
  const token = getToken()
  const headers = { 'Content-Type': 'application/json', ...opts.headers }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(BASE + path, { ...opts, headers })

  if (res.status === 401) {
    setToken(null)
    window.dispatchEvent(new Event('signal:logout'))
    throw new Error('Not authenticated')
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || res.statusText)
  }
  if (res.headers.get('content-type')?.includes('text/csv')) return res
  return res.json()
}

export const api = {
  // Auth
  authStatus: () => fetch(BASE + '/auth/status').then(r => r.json()),
  login: (username, password) => req('/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password })
  }),
  register: (username, password) => req('/auth/register', {
    method: 'POST', body: JSON.stringify({ username, password })
  }),
  me: () => req('/auth/me'),
  setApiKey: (api_key) => req('/auth/api-key', {
    method: 'POST', body: JSON.stringify({ api_key })
  }),
  changePassword: (old_password, new_password) => req('/auth/change-password', {
    method: 'POST', body: JSON.stringify({ old_password, new_password })
  }),

  // Articles
  getArticles: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))
    return req(`/articles?${qs}`)
  },
  getArticle: (id) => req(`/articles/${id}`),
  tagArticle: (id, tag) => req(`/articles/${id}/tag`, {
    method: 'POST', body: JSON.stringify({ tag })
  }),
  analyzeArticle: (id) => req(`/articles/${id}/analyze`, { method: 'POST' }),
  unreadCount: () => req('/articles/unread/count'),

  // Positions
  getPositions: () => req('/positions'),
  createPosition: (data) => req('/positions', { method: 'POST', body: JSON.stringify(data) }),
  updatePosition: (id, data) => req(`/positions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePosition: (id) => req(`/positions/${id}`, { method: 'DELETE' }),

  // Price
  getPrice: (symbol) => req(`/price/${encodeURIComponent(symbol)}`),

  // Calculations
  getCalculations: () => req('/calculations'),
  saveCalculation: (name, data) => req('/calculations', {
    method: 'POST', body: JSON.stringify({ name, data })
  }),
  deleteCalculation: (name) => req(`/calculations/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Daily digest
  getDigestDates: () => req('/digest/dates'),
  getDigest: (date) => req(`/digest/${date}`),
  generateDigest: (date) => req('/digest/generate', {
    method: 'POST', body: JSON.stringify({ date })
  }),

  // Settings
  getSettings: () => req('/settings'),
  updateSettings: (data) => req('/settings', { method: 'POST', body: JSON.stringify(data) }),
  getSources: () => req('/settings/sources'),
  saveSources: (sources) => req('/settings/sources', {
    method: 'POST', body: JSON.stringify({ sources })
  }),
  testSource: (source) => req('/settings/sources/test', {
    method: 'POST', body: JSON.stringify({ source })
  }),

  // Globe
  globeData: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))
    return req(`/globe/data?${qs}`)
  },

  // Data
  purgeData: () => req('/data/purge', { method: 'POST' }),
  exportData: () => req('/data/export'),
}
