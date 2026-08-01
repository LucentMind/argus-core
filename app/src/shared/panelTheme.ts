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

/**
 * Both maps are hand-copies of the renderer's `theme.css` — the panel preload cannot read the
 * renderer's stylesheet — under this fixed token mapping:
 *
 *     bg → --bg-1    surface → --bg-2   surface-2 → --bg-hi   text → --ink
 *     dim → --dim    faint → --faint    hair → --hair
 *     accent → --signal                 danger → --danger
 *
 * The mapping is the contract; the VALUES track theme.css and change with it.
 * `panels.test.ts` reads theme.css from disk and holds both copies to it.
 */
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
  bg: '#eef2f9',
  surface: '#ffffff',
  'surface-2': 'rgba(255, 255, 255, 0.62)',
  text: '#101823',
  dim: 'rgba(28, 42, 64, 0.68)',
  faint: 'rgba(28, 42, 64, 0.3)',
  hair: 'rgba(26, 48, 84, 0.09)',
  accent: '#1f6fd0',
  danger: '#c93b3b'
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
