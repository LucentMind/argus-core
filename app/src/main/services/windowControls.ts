/**
 * Minimize / maximize / close, driven by the renderer's own caption buttons (spec
 * 2026-08-01-header-window-controls-design.md §3).
 *
 * Electron-free on purpose: `ControllableWindow` is a structural subset of `BrowserWindow`, so
 * this module is unit-testable without Electron (house DI convention) and a real BrowserWindow
 * satisfies it by shape.
 *
 * Every entry point tolerates `null` and a destroyed window. Both are reachable in practice: the
 * IPC handlers resolve their target with `BrowserWindow.fromWebContents`, which returns null for
 * a webContents with no window (a detached devtools view), and a click can be in flight when the
 * window is destroyed by something else.
 */

/** The subset of BrowserWindow this module drives. */
export interface ControllableWindow {
  isDestroyed(): boolean
  isMaximized(): boolean
  minimize(): void
  maximize(): void
  unmaximize(): void
  close(): void
}

function live(win: ControllableWindow | null): ControllableWindow | null {
  return win && !win.isDestroyed() ? win : null
}

export function minimizeWindow(win: ControllableWindow | null): void {
  live(win)?.minimize()
}

/** One button, two meanings — which is why this is a toggle here rather than two channels. */
export function toggleMaximizeWindow(win: ControllableWindow | null): void {
  const w = live(win)
  if (!w) return
  if (w.isMaximized()) w.unmaximize()
  else w.maximize()
}

export function closeWindow(win: ControllableWindow | null): void {
  live(win)?.close()
}

export function isWindowMaximized(win: ControllableWindow | null): boolean {
  return live(win)?.isMaximized() ?? false
}
