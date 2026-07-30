import { EDITOR_IPC, type EditorOpenRequest, type WindowBounds } from '../../shared/editorIpc'

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
}

export type EditorWindowFactory = (bounds: WindowBounds | null) => EditorWindowHandle

export interface EditorWindowDeps {
  createWindow: EditorWindowFactory
  loadBounds: () => WindowBounds | null
  saveBounds: (bounds: WindowBounds) => void
}

/**
 * Owns the single editor window. Single-instance by construction: `open` either creates the
 * window or focuses the existing one and adds a tab to it.
 */
export class EditorWindowService {
  private win: EditorWindowHandle | null = null

  constructor(private deps: EditorWindowDeps) {}

  isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  /** Exposed for wiring and tests; do not hold across a close. */
  handle(): EditorWindowHandle | null {
    return this.isOpen() ? this.win : null
  }

  open(req: EditorOpenRequest): void {
    if (!this.isOpen()) {
      const win = this.deps.createWindow(this.deps.loadBounds())
      this.win = win
      win.onClosed(() => {
        this.win = null
      })
      win.onBoundsChanged(() => {
        if (!win.isDestroyed()) this.deps.saveBounds(win.getBounds())
      })
    } else {
      this.win!.focus()
    }
    this.win!.send(EDITOR_IPC.openTab, req)
  }
}
