import fs from 'node:fs'
import path from 'node:path'
import { WebContentsView, BrowserWindow, session as electronSession } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { PanelThemeName } from '../../../shared/panelTheme'
import { panelContentType } from './protocol'
import type { OpenPanelInput, PanelView, PanelViewFactory, PanelViewHooks } from './panelHost'

/**
 * The real PanelViewFactory: one sandboxed WebContentsView per panel, on a
 * per-pack session partition with the strict CSP header, loaded over
 * argus-panel://. Reparenting (dock↔float) moves the SAME view, so panel state
 * is preserved (no reload).
 */
export function createElectronPanelFactory(
  getMainWindow: () => BrowserWindow | null,
  servePanel: (url: string) => { filePath: string; csp: string } | null
): PanelViewFactory {
  const partitionReady = new Set<string>()

  return {
    create(input: OpenPanelInput, hooks: PanelViewHooks): PanelView {
      const partition = `pack-panel:${input.packId}`
      const sess = electronSession.fromPartition(partition)

      // Serve argus-panel:// on THIS partition's session (handlers are per-session in
      // Electron — a default-session handler never fires for a partitioned panel). CSP
      // travels in the response, so it applies regardless of webRequest behavior.
      if (!partitionReady.has(partition)) {
        sess.protocol.handle('argus-panel', async (request) => {
          const served = servePanel(request.url)
          if (!served) return new Response('not found', { status: 404 })
          try {
            const data = await fs.promises.readFile(served.filePath)
            return new Response(new Uint8Array(data), {
              headers: {
                'content-type': panelContentType(served.filePath),
                'content-security-policy': served.csp
              }
            })
          } catch {
            return new Response('not found', { status: 404 })
          }
        })
        partitionReady.add(partition)
      }

      const view = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          session: sess,
          preload: path.join(__dirname, '../preload/panel.js'),
          additionalArguments: [
            `--argus-panel=${JSON.stringify({
              packId: input.packId,
              windowId: input.windowId,
              caseSlug: input.caseSlug,
              permissions: input.permissions
            })}`
          ]
        }
      })

      let floatWin: BrowserWindow | null = null
      let programmaticClose = false
      let lastTheme: PanelThemeName = 'dark'

      // Re-push the theme on every (re)load so a freshly-loaded panel is themed.
      view.webContents.on('did-finish-load', () => {
        if (!view.webContents.isDestroyed()) view.webContents.send(IPC.panelsTheme, lastTheme)
      })

      // Surface panel preload load failures on the main-process stdout — a
      // sandboxed panel's own console is otherwise invisible, so a broken preload
      // (e.g. a throw before contextBridge exposes window.argus) fails silently.
      view.webContents.on('preload-error', (_e, preloadPath, error) => {
        console.error(
          `[panel:${input.packId}/${input.windowId}] preload-error ${preloadPath}:`,
          error
        )
      })

      const attachDocked = (): void => {
        getMainWindow()?.contentView.addChildView(view)
      }
      attachDocked()

      const sizeToWindow = (win: BrowserWindow): void => {
        const [w, h] = win.getContentSize()
        view.setBounds({ x: 0, y: 0, width: w, height: h })
      }

      return {
        get webContentsId(): number {
          return view.webContents.id
        },
        loadPanel(url: string): void {
          view.webContents.loadURL(url).catch(() => {})
        },
        pushTheme(theme: PanelThemeName): void {
          lastTheme = theme
          if (!view.webContents.isDestroyed()) view.webContents.send(IPC.panelsTheme, theme)
        },
        floatOut(title: string): void {
          programmaticClose = false
          getMainWindow()?.contentView.removeChildView(view)
          floatWin = new BrowserWindow({ width: 900, height: 640, title, show: true })
          floatWin.contentView.addChildView(view)
          // The docked view may have been setVisible(false) (inactive/occluded);
          // it must be visible in its own window regardless.
          view.setVisible(true)
          sizeToWindow(floatWin)
          floatWin.on('resize', () => {
            if (floatWin) sizeToWindow(floatWin)
          })
          // User-initiated close (not our dockBack/destroy): reparent the view home
          // BEFORE the window is destroyed so its WebContents survives, then tell the
          // host to flip this panel back to docked.
          floatWin.on('close', () => {
            if (programmaticClose) return
            floatWin?.contentView.removeChildView(view)
            attachDocked()
            hooks.onFloatClosed()
          })
          floatWin.on('closed', () => {
            floatWin = null
          })
        },
        dockBack(): void {
          if (floatWin && !floatWin.isDestroyed()) {
            programmaticClose = true
            floatWin.contentView.removeChildView(view)
            floatWin.destroy()
            floatWin = null
          }
          attachDocked()
        },
        destroy(): void {
          if (floatWin && !floatWin.isDestroyed()) {
            programmaticClose = true
            floatWin.destroy()
            floatWin = null
          }
          getMainWindow()?.contentView.removeChildView(view)
          if (!view.webContents.isDestroyed()) view.webContents.close()
        },
        focus(): void {
          if (!view.webContents.isDestroyed()) view.webContents.focus()
        },
        setBounds(rect): void {
          view.setBounds(rect)
        },
        setVisible(visible): void {
          view.setVisible(visible)
        },
        sendCommand(requestId, cmd, args): void {
          if (!view.webContents.isDestroyed()) {
            view.webContents.send(IPC.panelsCommand, { requestId, cmd, args })
          }
        }
      }
    }
  }
}
