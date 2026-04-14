/**
 * Apply a theme object to CSS variables immediately without reload.
 * themeMap: { color_bg_primary: '#0a0a0f', ... }
 */
const CSS_VAR_MAP = {
  color_bg_primary: '--bg-primary',
  color_bg_secondary: '--bg-secondary',
  color_bg_tertiary: '--bg-tertiary',
  color_accent: '--accent',
  color_text_primary: '--text-primary',
  color_text_secondary: '--text-secondary',
  color_border: '--border',
  color_bullish: '--bullish',
  color_bearish: '--bearish',
  color_neutral: '--neutral',
  color_urgency_high: '--urgency-high',
  font_family: null, // handled separately
}

export function applyTheme(settings) {
  const root = document.documentElement
  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
    if (!cssVar) continue
    const val = settings[key]
    if (val) root.style.setProperty(cssVar, val)
  }

  // Derived: accent-dim is accent at 15% opacity
  if (settings.color_accent) {
    const hex = settings.color_accent
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      const r = parseInt(hex.slice(1, 3), 16)
      const g = parseInt(hex.slice(3, 5), 16)
      const b = parseInt(hex.slice(5, 7), 16)
      root.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.15)`)
    }
  }

  if (settings.font_family) {
    const map = {
      monospace: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
      'sans-serif': "'Inter', 'Segoe UI', system-ui, sans-serif",
      serif: "'Georgia', 'Times New Roman', serif",
    }
    root.style.setProperty('--font-family', map[settings.font_family] || settings.font_family)
  }
}

export function hexToRgba(hex, alpha = 1) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}
