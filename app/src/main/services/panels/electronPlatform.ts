import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebContentsView, BrowserWindow, session as electronSession, net, Menu } from 'electron'
import { is } from '@electron-toolkit/utils'
import { IPC } from '../../../shared/ipc'
import type { PanelThemeName } from '../../../shared/panelTheme'
import { panelContentType, resolveCaseAsset } from './protocol'
import type { OpenPanelInput, PanelView, PanelViewFactory, PanelViewHooks } from './panelHost'

/**
 * The real PanelViewFactory: one sandboxed WebContentsView per panel, on a
 * per-pack session partition with the strict CSP header, loaded over
 * argus-panel://. Reparenting (dock↔float) moves the SAME view, so panel state
 * is preserved (no reload).
 */
export function createElectronPanelFactory(
  getMainWindow: () => BrowserWindow | null,
  servePanel: (url: string) => { filePath: string; csp: string } | null,
  argusHome: string
): PanelViewFactory {
  const partitionReady = new Set<string>()
  const caseSchemeReady = new Set<string>()

  return {
    create(input: OpenPanelInput, hooks: PanelViewHooks): PanelView {
      // Case-scoped partition (3d-1): a partition never spans two cases, so the
      // argus-case handler registered on it can safely serve that one case's
      // evidence dir without needing per-request WebContents identity (which
      // Electron's protocol.handle doesn't expose).
      const partition = `pack-panel:${input.packId}:${input.caseSlug}`
      const sess = electronSession.fromPartition(partition)
      // The case this partition (and therefore this handler) is bound to. This is the
      // ONLY trusted case identity for argus-case reads — never the request URL's
      // hostname, which is renderer-supplied (see resolveCaseAsset).
      const boundCaseSlug = input.caseSlug

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

      // Registered lazily, and only for a window granted readCaseFiles — an
      // ungranted window sharing this (pack, case) partition still can't reach it
      // unless SOME window of the same pack+case opens with the permission first.
      if (input.permissions.includes('readCaseFiles') && !caseSchemeReady.has(partition)) {
        sess.protocol.handle('argus-case', async (request) => {
          const abs = resolveCaseAsset(argusHome, boundCaseSlug, request.url)
          if (!abs) return new Response('not found', { status: 404 })
          try {
            // Forward the request headers (notably Range:) so net.fetch over file://
            // can answer with 206 Partial Content — required for media seeking.
            const res = await net.fetch(pathToFileURL(abs).toString(), { headers: request.headers })
            // argus-case is a distinct origin from the panel's argus-panel:// bundle, so a
            // cross-origin fetch() needs an explicit ACAO to READ the bytes (spec §3 lists
            // fetch as a consumer, not just <img>/media). Access stays gated by the
            // per-(pack,case) partition registration + connect-src CSP, so '*' adds no reach.
            // Re-wrap to preserve the streamed body, status (incl. 206) and Content-* headers.
            const headers = new Headers(res.headers)
            headers.set('access-control-allow-origin', '*')
            headers.set(
              'access-control-expose-headers',
              'content-length, content-range, accept-ranges, content-type'
            )
            return new Response(res.body, {
              status: res.status,
              statusText: res.statusText,
              headers
            })
          } catch {
            return new Response('not found', { status: 404 })
          }
        })
        caseSchemeReady.add(partition)
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

      // Dev-only: a docked panel is a WebContentsView (not a BrowserWindow), so the app's
      // F12 handler never reaches it. Wire a right-click "Inspect element" that opens this
      // view's own devtools at the click point — the only way to see a panel's console /
      // Network tab. Gated to dev so sandboxed pack panels never expose devtools in prod.
      if (is.dev) {
        view.webContents.on('context-menu', (_e, params) => {
          Menu.buildFromTemplate([
            {
              label: 'Inspect element',
              click: () => {
                if (!view.webContents.isDestroyed()) {
                  view.webContents.inspectElement(params.x, params.y)
                }
              }
            }
          ]).popup()
        })
      }

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
