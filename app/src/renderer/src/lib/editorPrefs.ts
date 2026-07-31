/**
 * The editor window's own preferences, persisted to `localStorage` the way `uiStore` persists
 * the app's — not to `settings.json`. These are per-view display choices with no main-process
 * consumer, and routing them through IPC would buy nothing but latency.
 *
 * Every read validates: a hand-edited or half-written value must degrade to the default rather
 * than reach a CodeMirror theme as `NaN` or a layout as `Infinity`.
 */
export type ViewMode = 'editor' | 'split' | 'preview'

export interface EditorPrefs {
  fontSize: number
  wrap: boolean
  viewMode: ViewMode
  /** Editor's share of the split, 0–1. */
  splitFraction: number
}

export const FONT_MIN = 10
export const FONT_MAX = 24
export const FONT_DEFAULT = 13
/** Neither pane is useful below a fifth of the window. */
const SPLIT_MIN = 0.2
const SPLIT_MAX = 0.8

const KEYS = {
  fontSize: 'argus.editor.fontSize',
  wrap: 'argus.editor.wrap',
  viewMode: 'argus.editor.viewMode',
  splitFraction: 'argus.editor.splitFraction'
} as const

const MODES: readonly ViewMode[] = ['editor', 'split', 'preview']

export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return FONT_DEFAULT
  return Math.min(Math.max(Math.round(px), FONT_MIN), FONT_MAX)
}

export function clampSplitFraction(f: number): number {
  if (!Number.isFinite(f)) return 0.5
  return Math.min(Math.max(f, SPLIT_MIN), SPLIT_MAX)
}

export function nextViewMode(mode: ViewMode): ViewMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length]
}

export function readPrefs(): EditorPrefs {
  const rawSize = Number(localStorage.getItem(KEYS.fontSize))
  const rawSplit = Number(localStorage.getItem(KEYS.splitFraction))
  const rawMode = localStorage.getItem(KEYS.viewMode)
  return {
    // Number('') is 0 and Number('enormous') is NaN — both fail the range test below, so an
    // absent key and a corrupt one land on the same default without a special case.
    fontSize: rawSize >= FONT_MIN && rawSize <= FONT_MAX ? clampFontSize(rawSize) : FONT_DEFAULT,
    wrap: localStorage.getItem(KEYS.wrap) !== 'false',
    viewMode: MODES.includes(rawMode as ViewMode) ? (rawMode as ViewMode) : 'editor',
    splitFraction: Number.isFinite(rawSplit) && rawSplit > 0 ? clampSplitFraction(rawSplit) : 0.5
  }
}

export function writePrefs(patch: Partial<EditorPrefs>): void {
  if (patch.fontSize !== undefined) {
    localStorage.setItem(KEYS.fontSize, String(clampFontSize(patch.fontSize)))
  }
  if (patch.wrap !== undefined) localStorage.setItem(KEYS.wrap, String(patch.wrap))
  if (patch.viewMode !== undefined) localStorage.setItem(KEYS.viewMode, patch.viewMode)
  if (patch.splitFraction !== undefined) {
    localStorage.setItem(KEYS.splitFraction, String(clampSplitFraction(patch.splitFraction)))
  }
}
