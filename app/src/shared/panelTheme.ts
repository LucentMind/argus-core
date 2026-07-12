export type PanelThemeName = 'dark' | 'light'

/** Public panel token names (prefixed --argus-* on the panel document). */
export const PANEL_TOKENS = [
  'bg',
  'surface',
  'surface-2',
  'text',
  'dim',
  'faint',
  'hair',
  'accent',
  'danger'
] as const
export type PanelTokenName = (typeof PANEL_TOKENS)[number]

const DARK: Record<PanelTokenName, string> = {
  bg: '#0a0a0b',
  surface: '#111114',
  'surface-2': '#17171c',
  text: '#efede6',
  dim: 'rgba(239, 237, 230, 0.62)',
  faint: 'rgba(239, 237, 230, 0.18)',
  hair: 'rgba(255, 255, 255, 0.06)',
  accent: '#7ec4ff',
  danger: '#f27a6b'
}

const LIGHT: Record<PanelTokenName, string> = {
  bg: '#faf8f3',
  surface: '#ffffff',
  'surface-2': '#f0eee7',
  text: '#18181b',
  dim: 'rgba(24, 24, 27, 0.7)',
  faint: 'rgba(24, 24, 27, 0.25)',
  hair: 'rgba(0, 0, 0, 0.06)',
  accent: '#1567b3',
  danger: '#f27a6b'
}

/**
 * The `--argus-*` CSS custom properties the panel preload sets on the panel
 * document. A stable PUBLIC contract, deliberately decoupled from Core's
 * internal `--void`/`--ink` token names so panels don't break on renames.
 */
export function panelThemeVars(theme: PanelThemeName): Record<string, string> {
  const src = theme === 'light' ? LIGHT : DARK
  const out: Record<string, string> = {}
  for (const name of PANEL_TOKENS) out[`--argus-${name}`] = src[name]
  return out
}
