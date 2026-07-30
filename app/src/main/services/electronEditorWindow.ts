import { BrowserWindow, screen } from 'electron'
import { clampToDisplays } from '../../shared/editorWindowBounds'
import { EDITOR_DEFAULT_SIZE, EDITOR_MIN_SIZE, type WindowBounds } from '../../shared/editorIpc'
import type { EditorWindowFactory, EditorWindowHandle } from './editorWindow'

/**
 * The real window. Deliberately thin: create-or-focus, the close veto, and bounds clamping are
 * all in EditorWindowService / clampToDisplays, which are unit-tested. What is left here is
 * Electron API calls, covered by the CDP gate rather than by vitest.
 */
export function makeElectronEditorWindowFactory(
  preloadPath: string,
  loadEditor: (win: BrowserWindow) => void
): EditorWindowFactory {
  return (saved: WindowBounds | null): EditorWindowHandle => {
    // clampToDisplays treats workAreas[0] as the primary display, but
    // screen.getAllDisplays() does not guarantee the primary display comes first — put it
    // first explicitly.
    const primary = screen.getPrimaryDisplay()
    const workAreas = [
      primary.workArea,
      ...screen
        .getAllDisplays()
        .filter((d) => d.id !== primary.id)
        .map((d) => d.workArea)
    ]
    const bounds = saved ? clampToDisplays(saved, workAreas) : null

    const win = new BrowserWindow({
      width: bounds?.width ?? EDITOR_DEFAULT_SIZE.width,
      height: bounds?.height ?? EDITOR_DEFAULT_SIZE.height,
      ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
      minWidth: EDITOR_MIN_SIZE.width,
      minHeight: EDITOR_MIN_SIZE.height,
      show: false,
      autoHideMenuBar: true,
      title: 'Argus — Editor',
      webPreferences: { preload: preloadPath, sandbox: false }
    })

    win.on('ready-to-show', () => win.show())
    loadEditor(win)

    return {
      focus: () => {
        if (win.isMinimized()) win.restore()
        win.focus()
      },
      destroy: () => win.destroy(),
      isDestroyed: () => win.isDestroyed(),
      send: (channel, payload) => {
        if (!win.isDestroyed()) win.webContents.send(channel, payload)
      },
      getBounds: () => win.getBounds(),
      onCloseAttempt: (cb) => {
        win.on('close', (e) => {
          if (!cb()) e.preventDefault()
        })
      },
      onClosed: (cb) => win.on('closed', cb),
      onBoundsChanged: (cb) => {
        // 'moved' does not fire on Windows during a resize, and 'resize' fires continuously —
        // both are debounced by the caller writing at most one file per settle.
        let timer: NodeJS.Timeout | null = null
        const settle = (): void => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(cb, 400)
          timer.unref?.()
        }
        win.on('resize', settle)
        win.on('move', settle)
      }
    }
  }
}
