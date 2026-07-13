import { contextBridge, ipcRenderer } from 'electron'
import { buildPanelApi, PANEL_BRIDGE_CHANNELS } from '../shared/panels'
import { panelThemeVars, type PanelThemeName } from '../shared/panelTheme'

interface PanelConfig {
  packId: string
  windowId: string
  caseSlug: string
  permissions: string[]
}

/** PanelHost passes identity+grant via webPreferences.additionalArguments. */
function readConfig(): PanelConfig {
  const empty: PanelConfig = { packId: '', windowId: '', caseSlug: '', permissions: [] }
  const arg = process.argv.find((a) => a.startsWith('--argus-panel='))
  if (!arg) return empty
  try {
    return { ...empty, ...(JSON.parse(arg.slice('--argus-panel='.length)) as Partial<PanelConfig>) }
  } catch {
    return empty
  }
}

function applyTheme(theme: PanelThemeName): void {
  // A sandboxed preload runs at document-start, before <html> exists, so
  // documentElement can be null. Guard it — an unguarded throw here aborts the
  // WHOLE preload (before contextBridge exposes window.argus).
  const root = document.documentElement
  if (!root) return
  for (const [k, v] of Object.entries(panelThemeVars(theme))) root.style.setProperty(k, v)
}

const config = readConfig()
const argus = buildPanelApi(config.permissions, (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args)
)

ipcRenderer.on(PANEL_BRIDGE_CHANNELS.theme, (_e, theme: PanelThemeName) => applyTheme(theme))
// Themed first paint. Deferred to DOM-ready because documentElement doesn't exist
// yet when the sandboxed preload runs; PanelHost re-pushes the real theme on load.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => applyTheme('dark'))
} else {
  applyTheme('dark')
}

// Downstream command dispatch (main → panel → main reply). The pack registers
// at most one handler via onCommand; a dispatched command runs it and replies
// over commandResult, correlated by requestId (PanelHost.resolveCommand).
let commandHandler: ((cmd: string, args: unknown[]) => unknown) | null = null
const argusWithCommands = {
  ...argus,
  onCommand(handler: (cmd: string, args: unknown[]) => unknown): void {
    commandHandler = handler
  }
}
ipcRenderer.on(
  PANEL_BRIDGE_CHANNELS.command,
  async (_e, req: { requestId: string; cmd: string; args: unknown[] }) => {
    try {
      const result = commandHandler ? await commandHandler(req.cmd, req.args) : undefined
      ipcRenderer.send(PANEL_BRIDGE_CHANNELS.commandResult, {
        requestId: req.requestId,
        ok: true,
        result
      })
    } catch (e) {
      ipcRenderer.send(PANEL_BRIDGE_CHANNELS.commandResult, {
        requestId: req.requestId,
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }
)

export type PanelApi = typeof argusWithCommands

// Panels ALWAYS run contextIsolation:true (set in electronPlatform), so expose
// via contextBridge unconditionally. Under sandbox:true, process.contextIsolated
// is not reliably populated; the old DOM-global fallback would then write
// window.argus into the preload's ISOLATED world — invisible to the page — even
// though theme injection (a shared-DOM API) still works. That mismatch is
// exactly the "window.argus is undefined but theme works" symptom.
try {
  contextBridge.exposeInMainWorld('argus', argusWithCommands)
} catch (error) {
  console.error('[argus-panel] contextBridge.exposeInMainWorld failed', error)
}
