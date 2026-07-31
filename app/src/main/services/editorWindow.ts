import {
  EDITOR_IPC,
  type EditorOpenRequest,
  type PersistedTabs,
  type WindowBounds
} from '../../shared/editorIpc'
import type { TitleBarTheme } from './titleBar'

/** The editor window as this service needs it. An interface, not a BrowserWindow, so the
 *  service is unit-testable without Electron (house DI convention). */
export interface EditorWindowHandle {
  focus(): void
  destroy(): void
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
  getBounds(): WindowBounds
  /** The user tried to close the window. Return true to allow, false to veto. */
  onCloseAttempt(cb: () => boolean): void
  /** The window is gone. */
  onClosed(cb: () => void): void
  /** The window was moved or resized. */
  onBoundsChanged(cb: () => void): void
  /** Re-tint the window's native system buttons after a theme change. */
  applyTheme(theme: TitleBarTheme): void
}

export type EditorWindowFactory = (bounds: WindowBounds | null) => EditorWindowHandle

export interface EditorWindowDeps {
  createWindow: EditorWindowFactory
  loadBounds: () => WindowBounds | null
  saveBounds: (bounds: WindowBounds) => void
  loadTabs: () => PersistedTabs | null
  /**
   * Write main's debounced tab set to disk NOW.
   *
   * `loadTabs` reads a file, and main holds the last ~1s of tab changes in memory before writing
   * it. Close your last tab and then close the window inside that second, and the next `open()`
   * restores the pre-close state — resurrecting exactly the tabs the user had just closed, the
   * failure the restore-on-creation comment below exists to avoid. Main stays the debounce owner
   * (spec §4.2's policy); this is only a "settle before you read" handshake, and it is emphatically
   * not a renderer-side flush — the renderer's window may already be gone by then.
   */
  flushTabs: () => void
}

/**
 * Owns the single editor window. Single-instance by construction: `open` either creates the
 * window or focuses the existing one and adds a tab to it.
 */
export class EditorWindowService {
  private win: EditorWindowHandle | null = null
  private dirtyCount = 0
  /** True between vetoing a close and the renderer's answer. Guards against re-asking when
   *  the user clicks the X repeatedly while the confirm is on screen. */
  private awaitingCloseReply = false

  constructor(private deps: EditorWindowDeps) {}

  isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  /** Exposed for wiring and tests; do not hold across a close. */
  handle(): EditorWindowHandle | null {
    return this.isOpen() ? this.win : null
  }

  setDirtyCount(n: number): void {
    this.dirtyCount = n
  }

  /**
   * Fan a theme change out to the window. Main owns this rather than the renderer because the
   * system buttons are painted by the OS, not by the page — no amount of CSS moves them.
   */
  applyTheme(theme: TitleBarTheme): void {
    this.handle()?.applyTheme(theme)
  }

  open(req: EditorOpenRequest): void {
    if (!this.isOpen()) {
      const win = this.deps.createWindow(this.deps.loadBounds())
      this.win = win
      this.dirtyCount = 0
      this.awaitingCloseReply = false

      win.onCloseAttempt(() => this.allowClose())
      // Identity-guarded: Electron's `closed` is asynchronous, so a previous window's event
      // can arrive after a replacement has been adopted. Without `this.win === win` the stale
      // handler nulls out the LIVE window, orphaning it on screen and making the next open()
      // spawn a third.
      win.onClosed(() => {
        if (this.win !== win) return
        this.win = null
        this.awaitingCloseReply = false
      })
      win.onBoundsChanged(() => {
        if (this.win !== win || win.isDestroyed()) return
        this.deps.saveBounds(win.getBounds())
      })

      // Restore belongs to window CREATION, not to opening an asset: replaying the set into a
      // live window would resurrect tabs the user had just closed. The order matters too —
      // the renderer dedupes on open, so restore-then-open focuses the clicked asset when it
      // was already among the restored tabs instead of opening a duplicate.
      //
      // Settled before it is read: the set main is still holding in memory is newer than the file
      // `loadTabs` reads, and reopening inside the debounce window would otherwise resurrect the
      // tabs the user had just closed — the very failure this restore exists to avoid. See
      // `flushTabs` on the deps.
      this.deps.flushTabs()
      const restored = this.deps.loadTabs()
      if (restored && restored.tabs.length > 0) win.send(EDITOR_IPC.restoreTabs, restored)
    } else {
      this.win!.focus()
    }
    this.win!.send(EDITOR_IPC.openTab, req)
  }

  /** The close hook. Returns true to let the window go. */
  private allowClose(): boolean {
    if (this.dirtyCount === 0) return true
    if (this.awaitingCloseReply) return false
    this.awaitingCloseReply = true
    this.win?.send(EDITOR_IPC.closeRequested, { dirtyCount: this.dirtyCount })
    return false
  }

  /** The renderer's answer to `closeRequested`. */
  resolveClose(allow: boolean): void {
    if (!this.awaitingCloseReply) return
    this.awaitingCloseReply = false
    if (allow) this.forceClose()
  }

  /** Destroy the window without asking. Used by the reply path and by main-window teardown. */
  forceClose(): void {
    if (!this.isOpen()) return
    this.win!.destroy()
  }
}
