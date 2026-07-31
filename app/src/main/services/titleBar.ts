/**
 * Window chrome for the two Argus-rendered windows (spec 2026-07-31-frameless-window-chrome).
 *
 * Electron-free on purpose: `OverlayWindow` is a structural subset of `BrowserWindow`, so this
 * module is unit-testable without Electron (house DI convention) and a real BrowserWindow
 * satisfies it by shape.
 */

export type TitleBarKind = 'main' | 'editor'
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

/** Main matches TopBar's existing `h-16`, so adopting the overlay relayouts nothing. */
const HEIGHTS: Record<TitleBarKind, number> = { main: 64, editor: 40 }

export function overlayFor(kind: TitleBarKind, theme: TitleBarTheme): TitleBarOverlay {
  return { ...PALETTE[theme], height: HEIGHTS[kind] }
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
  platform: NodeJS.Platform = process.platform
): TitleBarWindowOptions {
  const overlay = overlayFor(kind, theme)
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
  theme: TitleBarTheme
): void {
  if (!win || win.isDestroyed()) return
  win.setTitleBarOverlay?.(overlayFor(kind, theme))
}
