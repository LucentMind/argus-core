/**
 * Window chrome for the two Argus-rendered windows (spec 2026-07-31-frameless-window-chrome).
 *
 * Electron-free on purpose: `OverlayWindow` is a structural subset of `BrowserWindow`, so this
 * module is unit-testable without Electron (house DI convention) and a real BrowserWindow
 * satisfies it by shape.
 */

import { TITLEBAR_HEIGHTS, type TitleBarKind } from '../../shared/titleBarHeights'

export type { TitleBarKind }
export type TitleBarTheme = 'dark' | 'light'

export interface TitleBarOverlay {
  color: string
  symbolColor: string
  height: number
}

/**
 * Copied from the renderer's tokens (`assets/theme.css`): `color` is `--bg-1` — Tailwind
 * `bg-deep`, the surface both title bars sit on — and `symbolColor` is `--ink`. Main cannot read
 * the renderer's stylesheet, so this is a hand-maintained duplicate; change it with theme.css.
 *
 * Opaque hex deliberately. `--dim` is the token these glyphs would otherwise take, but it is
 * `rgba()` and titleBarOverlay accepts only solid colours.
 */
const PALETTE: Record<TitleBarTheme, { color: string; symbolColor: string }> = {
  dark: { color: '#0a0a0b', symbolColor: '#efede6' },
  light: { color: '#faf8f3', symbolColor: '#18181b' }
}

/**
 * `scale` mirrors the renderer's `uiScale` (`webFrame.setZoomFactor`, 0.9-1.5): page zoom scales
 * the DOM but not browser-side window constructs like `titleBarOverlay`, so without this the OS
 * reserves the unscaled height while the strip renders at the zoomed one and the buttons bite
 * into the header below (see `PanelDock.tsx`'s comment for the same failure class). Defaults to
 * 1 so every existing caller is unaffected.
 */
export function overlayFor(kind: TitleBarKind, theme: TitleBarTheme, scale = 1): TitleBarOverlay {
  return { ...PALETTE[theme], height: Math.round(TITLEBAR_HEIGHTS[kind] * scale) }
}

export interface TitleBarWindowOptions {
  titleBarStyle: 'hidden'
  titleBarOverlay: TitleBarOverlay | { height: number }
  backgroundColor: string
}

/**
 * Spread into `new BrowserWindow({...})`.
 *
 * `platform` is a parameter rather than a `process.platform` read so both branches are reachable
 * from a test on either OS. macOS draws its own traffic lights and honours only `height` on the
 * overlay — colours passed there are silently ignored, so we do not pass them.
 */
export function titleBarWindowOptions(
  kind: TitleBarKind,
  theme: TitleBarTheme,
  platform: NodeJS.Platform = process.platform,
  scale = 1
): TitleBarWindowOptions {
  const overlay = overlayFor(kind, theme, scale)
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: platform === 'darwin' ? { height: overlay.height } : overlay,
    backgroundColor: PALETTE[theme].color
  }
}

/** The subset of BrowserWindow this module drives. */
export interface OverlayWindow {
  isDestroyed(): boolean
  /** Windows/Linux only — absent on macOS, where the traffic lights are not ours to colour. */
  setTitleBarOverlay?: (options: TitleBarOverlay) => void
}

/** Re-tint a live window's system buttons. No-op on macOS and on a window already gone. */
export function applyOverlay(
  win: OverlayWindow | null,
  kind: TitleBarKind,
  theme: TitleBarTheme,
  scale = 1
): void {
  if (!win || win.isDestroyed()) return
  win.setTitleBarOverlay?.(overlayFor(kind, theme, scale))
}

/**
 * The subset of `EditorWindowService` this module drives to keep the editor window's overlay in
 * sync with the main window's. A structural interface — not an import of `EditorWindowService` —
 * so this module stays Electron-free and free of the editor window's own DI graph.
 */
export interface EditorChrome {
  applyTheme(theme: TitleBarTheme): void
  applyScale(scale: number): void
}

/**
 * Push a theme change to both windows' overlays, unless it is a no-op.
 *
 * Extracted from the `panels:set-theme` IPC handler in `index.ts` — which cannot be imported
 * under vitest, since it boots Electron at module scope — so review issue 6's fix has a seam a
 * test can drive with fakes: main was re-pushing `setTitleBarOverlay` on every renderer load
 * (including the first, where the value is identical, and every HMR reload), which is the
 * one in-diff suspect for a live defect where the main window's overlay came up zero-width.
 *
 * The caller is responsible for updating its own `lastTheme` (before calling this, per review
 * issue 6 — a throw here must not leave that bookkeeping stale) and for deciding whether to
 * still run theme-adjacent work (`panelHost.setTheme`, the cross-window broadcast) that this
 * function does not know about.
 */
export function pushThemeIfChanged(
  mainWin: OverlayWindow | null,
  editor: EditorChrome | null,
  theme: TitleBarTheme,
  prevTheme: TitleBarTheme,
  scale = 1
): boolean {
  if (theme === prevTheme) return false
  applyOverlay(mainWin, 'main', theme, scale)
  editor?.applyTheme(theme)
  return true
}

/** The scale-change counterpart to {@link pushThemeIfChanged}; see its doc comment. */
export function pushScaleIfChanged(
  mainWin: OverlayWindow | null,
  editor: EditorChrome | null,
  scale: number,
  prevScale: number,
  theme: TitleBarTheme
): boolean {
  if (scale === prevScale) return false
  applyOverlay(mainWin, 'main', theme, scale)
  editor?.applyScale(scale)
  return true
}
