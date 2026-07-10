import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type { NewCaseInput, SearchFilters, ApprovalDecision } from '../shared/types'
import type { AgentEvent } from '../shared/agent-events'
import type { SettingsPayload } from '../shared/settings'
import type { ConnectorsPayload } from '../shared/connectors'
import type { HealthCheckResult } from '../shared/health'

// Custom API for renderer
const argus = {
  cases: {
    create: (input: NewCaseInput) => ipcRenderer.invoke(IPC.casesCreate, input),
    list: () => ipcRenderer.invoke(IPC.casesList),
    cost: (caseSlug: string) => ipcRenderer.invoke(IPC.caseCost, caseSlug),
    readFindings: (caseSlug: string) => ipcRenderer.invoke(IPC.caseReadFindings, caseSlug)
  },
  evidence: {
    ingest: (caseSlug: string, absPaths: string[]) =>
      ipcRenderer.invoke(IPC.evidenceIngest, caseSlug, absPaths),
    list: (caseSlug: string) => ipcRenderer.invoke(IPC.evidenceList, caseSlug),
    read: (evidenceId: number, focusLine?: number) =>
      ipcRenderer.invoke(IPC.evidenceRead, evidenceId, focusLine),
    onChanged: (cb: (caseSlug: string) => void): (() => void) => {
      const listener = (_e: unknown, caseSlug: string): void => cb(caseSlug)
      ipcRenderer.on(IPC.evidenceChanged, listener)
      return () => ipcRenderer.removeListener(IPC.evidenceChanged, listener)
    }
  },
  search: {
    query: (q: string, filters?: SearchFilters) => ipcRenderer.invoke(IPC.searchQuery, q, filters)
  },
  agent: {
    send: (caseSlug: string, text: string) => ipcRenderer.invoke(IPC.agentSend, caseSlug, text),
    interrupt: (caseSlug: string) => ipcRenderer.invoke(IPC.agentInterrupt, caseSlug),
    respond: (caseSlug: string, d: ApprovalDecision) =>
      ipcRenderer.invoke(IPC.agentRespond, caseSlug, d),
    authStatus: (force?: boolean) => ipcRenderer.invoke(IPC.agentAuthStatus, force),
    history: (caseSlug: string): Promise<AgentEvent[]> =>
      ipcRenderer.invoke(IPC.agentHistory, caseSlug),
    preflight: () => ipcRenderer.invoke(IPC.agentPreflight),
    onEvent: (cb: (e: AgentEvent) => void): (() => void) => {
      const listener = (_e: unknown, ev: AgentEvent): void => cb(ev)
      ipcRenderer.on(IPC.agentEventChannel, listener)
      return () => ipcRenderer.removeListener(IPC.agentEventChannel, listener)
    }
  },
  workspaces: {
    pick: () => ipcRenderer.invoke(IPC.workspacesPick),
    link: (caseSlug: string, repoPath: string) =>
      ipcRenderer.invoke(IPC.workspacesLink, caseSlug, repoPath),
    unlink: (caseSlug: string, repoPath: string) =>
      ipcRenderer.invoke(IPC.workspacesUnlink, caseSlug, repoPath),
    list: (caseSlug: string) => ipcRenderer.invoke(IPC.workspacesList, caseSlug)
  },
  skills: {
    list: () => ipcRenderer.invoke(IPC.skillsList)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    patch: (p: unknown) => ipcRenderer.invoke(IPC.settingsPatch, p),
    probeTools: () => ipcRenderer.invoke(IPC.settingsProbeTools),
    pickPath: (mode: 'file' | 'directory') => ipcRenderer.invoke(IPC.settingsPickPath, mode),
    reveal: (what: 'dataRoot' | 'settingsFile') => ipcRenderer.invoke(IPC.settingsReveal, what),
    onChanged: (cb: (p: SettingsPayload) => void): (() => void) => {
      const listener = (_e: unknown, p: SettingsPayload): void => cb(p)
      ipcRenderer.on(IPC.settingsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.settingsChanged, listener)
    }
  },
  connectors: {
    get: () => ipcRenderer.invoke(IPC.connectorsGet),
    patch: (p: unknown) => ipcRenderer.invoke(IPC.connectorsPatch, p),
    test: (id: string) => ipcRenderer.invoke(IPC.connectorsTest, id),
    oauth: (id: string) => ipcRenderer.invoke(IPC.connectorsOauth, id),
    onChanged: (cb: (p: ConnectorsPayload) => void): (() => void) => {
      const listener = (_e: unknown, p: ConnectorsPayload): void => cb(p)
      ipcRenderer.on(IPC.connectorsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.connectorsChanged, listener)
    }
  },
  secrets: {
    set: (name: string, value: string) => ipcRenderer.invoke(IPC.secretsSet, name, value),
    has: (name: string) => ipcRenderer.invoke(IPC.secretsHas, name),
    delete: (name: string) => ipcRenderer.invoke(IPC.secretsDelete, name)
  },
  health: {
    list: () => ipcRenderer.invoke(IPC.healthList),
    run: (ids?: string[]) => ipcRenderer.invoke(IPC.healthRun, ids),
    onResult: (cb: (r: HealthCheckResult) => void): (() => void) => {
      const listener = (_e: unknown, r: HealthCheckResult): void => cb(r)
      ipcRenderer.on(IPC.healthResult, listener)
      return () => ipcRenderer.removeListener(IPC.healthResult, listener)
    }
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.appOpenExternal, url)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('argus', argus)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.argus = argus
}

export type ArgusApi = typeof argus
