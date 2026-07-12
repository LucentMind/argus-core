import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import { buildPanelApi } from '../shared/panels'
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
  const root = document.documentElement
  for (const [k, v] of Object.entries(panelThemeVars(theme))) root.style.setProperty(k, v)
}

const config = readConfig()
const argus = buildPanelApi(config.permissions, (channel, ...args) => ipcRenderer.invoke(channel, ...args))

ipcRenderer.on(IPC.panelsTheme, (_e, theme: PanelThemeName) => applyTheme(theme))
applyTheme('dark') // themed first paint; PanelHost pushes the real theme on load

export type PanelApi = typeof argus

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('argus', argus)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (defined in panel.d.ts)
  window.argus = argus
}
