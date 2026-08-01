import { BrowserWindow, screen } from 'electron'
import { clampToDisplays } from '../../shared/editorWindowBounds'
import { EDITOR_DEFAULT_SIZE, EDITOR_MIN_SIZE, type WindowBounds } from '../../shared/editorIpc'
import type { EditorWindowFactory, EditorWindowHandle } from './editorWindow'
import { applyOverlay, type TitleBarTheme } from './titleBar'
import { editorWindowOptions } from './windowOptions'

/**
 * The real window. Deliberately thin: create-or-focus, the close veto, and bounds clamping are
 * all in EditorWindowService / clampToDisplays, which are unit-tested. What is left here is
 * Electron API calls, covered by the CDP gate rather than by vitest.
 */
export function makeElectronEditorWindowFactory(
  preloadPath: string,
  loadEditor: (win: BrowserWindow) => void,
  getTheme: () => TitleBarTheme,
  getScale: () => number
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
      // The caption bar no longer renders this, but the taskbar entry and Alt-Tab still do.
      title: 'Argus — Editor',
      ...editorWindowOptions(getTheme(), getScale(), preloadPath)
    })

    win.on('ready-to-show', () => win.show())

    // `send()` calls made before the page has actually finished loading are lost: at the
    // instant `loadEditor` returns, `loadURL`/`loadFile` has only just started and no
    // `ipcRenderer.on(...)` listener exists yet in the renderer. Buffer sends until
    // `did-finish-load`, then flush them in order. `did-start-loading` fires again on every
    // reload (including the initial load, before buffering is even needed), so it re-arms
    // buffering for the next `did-finish-load` — a reload's listeners are gone too until then.
    let ready = false
    let queue: Array<{ channel: string; payload: unknown }> = []

    win.webContents.on('did-start-loading', () => {
      ready = false
    })
    win.webContents.on('did-finish-load', () => {
      ready = true
      const pending = queue
      queue = []
      for (const { channel, payload } of pending) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(channel, payload)
        }
      }
    })

    loadEditor(win)

    return {
      focus: () => {
        if (!win.isVisible()) win.show()
        if (win.isMinimized()) win.restore()
        win.focus()
      },
      destroy: () => win.destroy(),
      isDestroyed: () => win.isDestroyed(),
      send: (channel, payload) => {
        if (win.isDestroyed() || win.webContents.isDestroyed()) return
        if (!ready) {
          queue.push({ channel, payload })
          return
        }
        win.webContents.send(channel, payload)
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
        let pending = false
        const settle = (): void => {
          if (timer) clearTimeout(timer)
          pending = true
          timer = setTimeout(() => {
            pending = false
            timer = null
            cb()
          }, 400)
          timer.unref?.()
        }
        win.on('resize', settle)
        win.on('move', settle)
        // A resize/move immediately followed by a close would otherwise discard the final
        // bounds (the debounce timer never fires) and leak the timer. Flush synchronously.
        win.once('close', () => {
          if (timer) clearTimeout(timer)
          if (pending) {
            pending = false
            timer = null
            cb()
          }
        })
      },
      // `getTheme`/`getScale` are read at call time (not captured at construction), so a theme
      // push carries whatever scale main currently knows and vice versa — each is the other's
      // counterpart's source of truth, mirroring `titleBarWindowOptions` above.
      applyTheme: (theme) => applyOverlay(win, 'editor', theme, getScale()),
      applyScale: (scale) => applyOverlay(win, 'editor', getTheme(), scale)
    }
  }
}
