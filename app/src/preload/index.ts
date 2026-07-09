import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type { NewCaseInput, SearchFilters, ApprovalDecision } from '../shared/types'
import type { AgentEvent } from '../shared/agent-events'

// Custom API for renderer
const argus = {
  cases: {
    create: (input: NewCaseInput) => ipcRenderer.invoke(IPC.casesCreate, input),
    list: () => ipcRenderer.invoke(IPC.casesList),
    cost: (caseSlug: string) => ipcRenderer.invoke(IPC.caseCost, caseSlug),
    readFindings: (caseSlug: string) => ipcRenderer.invoke(IPC.caseReadFindings, caseSlug)
  },
  evidence: {
    ingest: (caseSlug: string, absPaths: string[]) => ipcRenderer.invoke(IPC.evidenceIngest, caseSlug, absPaths),
    list: (caseSlug: string) => ipcRenderer.invoke(IPC.evidenceList, caseSlug),
    read: (evidenceId: number) => ipcRenderer.invoke(IPC.evidenceRead, evidenceId)
  },
  search: {
    query: (q: string, filters?: SearchFilters) => ipcRenderer.invoke(IPC.searchQuery, q, filters)
  },
  agent: {
    send: (caseSlug: string, text: string) => ipcRenderer.invoke(IPC.agentSend, caseSlug, text),
    interrupt: (caseSlug: string) => ipcRenderer.invoke(IPC.agentInterrupt, caseSlug),
    respond: (caseSlug: string, d: ApprovalDecision) => ipcRenderer.invoke(IPC.agentRespond, caseSlug, d),
    authStatus: () => ipcRenderer.invoke(IPC.agentAuthStatus),
    history: (caseSlug: string): Promise<AgentEvent[]> => ipcRenderer.invoke(IPC.agentHistory, caseSlug),
    preflight: () => ipcRenderer.invoke(IPC.agentPreflight),
    onEvent: (cb: (e: AgentEvent) => void): (() => void) => {
      const listener = (_e: unknown, ev: AgentEvent): void => cb(ev)
      ipcRenderer.on(IPC.agentEventChannel, listener)
      return () => ipcRenderer.removeListener(IPC.agentEventChannel, listener)
    }
  },
  workspaces: {
    pick: () => ipcRenderer.invoke(IPC.workspacesPick),
    link: (caseSlug: string, repoPath: string) => ipcRenderer.invoke(IPC.workspacesLink, caseSlug, repoPath),
    unlink: (caseSlug: string, repoPath: string) => ipcRenderer.invoke(IPC.workspacesUnlink, caseSlug, repoPath),
    list: (caseSlug: string) => ipcRenderer.invoke(IPC.workspacesList, caseSlug)
  },
  skills: {
    list: () => ipcRenderer.invoke(IPC.skillsList)
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file)
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
