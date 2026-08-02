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
  light: { color: '#eef2f9', symbolColor: '#101823' }
}

/**
 * `scale` mirrors the renderer's `uiScale` (`webFrame.setZoomFactor`, 0.9-1.5): page zoom scales
 * the DOM but not browser-side window constructs like `titleBarOverlay`. `scale` is editor-only
 * now — the main window no longer takes a native overlay to scale at all. The editor's strip is
 * its ONE row of chrome: the tab bar and each pane's action buttons render directly inside it,
 * there is no header below (`EditorApp.tsx`'s "ONE row of chrome" comment). So without this the OS
 * reserves the unscaled height for its native caption-button cluster while the strip's own
 * content renders at the zoomed one, and the buttons drift out of alignment with the strip they
 * sit in (see `PanelDock.tsx`'s comment for the same failure class: native constructs don't track
 * DOM zoom). Defaults to 1 so every existing caller is unaffected.
 */
export function overlayFor(kind: TitleBarKind, theme: TitleBarTheme, scale = 1): TitleBarOverlay {
  return { ...PALETTE[theme], height: Math.round(TITLEBAR_HEIGHTS[kind] * scale) }
}

export interface TitleBarWindowOptions {
  titleBarStyle: 'hidden'
  /** Absent for the MAIN window on win32/linux — it draws its own caption buttons, and an
   *  overlay would paint an opaque OS-owned rectangle over the top-right of the header that the
   *  ambient flow cannot read through (spec §3.1). Present everywhere else. */
  titleBarOverlay?: TitleBarOverlay | { height: number }
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
  const backgroundColor = PALETTE[theme].color
  // `titleBarStyle: 'hidden'` with NO overlay is what removes the native caption buttons while
  // keeping the native frame's resize borders, drop shadow, and snap behaviour — which is why
  // this is not `frame: false`.
  if (kind === 'main' && platform !== 'darwin') return { titleBarStyle: 'hidden', backgroundColor }
  const overlay = overlayFor(kind, theme, scale)
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: platform === 'darwin' ? { height: overlay.height } : overlay,
    backgroundColor
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
 * Push a theme change to the editor window's overlay, unless it is a no-op.
 *
 * The main window is deliberately absent: it is constructed without a `titleBarOverlay` on
 * win32/linux (see `titleBarWindowOptions`), and `setTitleBarOverlay` THROWS on such a window;
 * on darwin the method does not exist at all. Its caption buttons are DOM elements now, so they
 * re-theme and re-scale with the renderer for free — which also retires the whole
 * `webFrame.setZoomFactor`-vs-native-hit-box mismatch class the `scale` parameter existed for.
 *
 * The caller is responsible for updating its own `lastTheme` BEFORE calling this (a throw here
 * must not leave that bookkeeping stale) and for deciding whether to still run theme-adjacent
 * work — `panelHost.setTheme`, the cross-window broadcast — that this function does not know
 * about.
 */
export function pushThemeIfChanged(
  editor: EditorChrome | null,
  theme: TitleBarTheme,
  prevTheme: TitleBarTheme
): boolean {
  if (theme === prevTheme) return false
  editor?.applyTheme(theme)
  return true
}

/** The scale-change counterpart to {@link pushThemeIfChanged}; see its doc comment. */
export function pushScaleIfChanged(
  editor: EditorChrome | null,
  scale: number,
  prevScale: number
): boolean {
  if (scale === prevScale) return false
  editor?.applyScale(scale)
  return true
}
