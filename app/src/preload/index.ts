import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type { NewCaseInput, SearchFilters } from '../shared/types'

// Custom API for renderer
const argus = {
  cases: {
    create: (input: NewCaseInput) => ipcRenderer.invoke(IPC.casesCreate, input),
    list: () => ipcRenderer.invoke(IPC.casesList)
  },
  evidence: {
    ingest: (caseSlug: string, absPaths: string[]) => ipcRenderer.invoke(IPC.evidenceIngest, caseSlug, absPaths),
    list: (caseSlug: string) => ipcRenderer.invoke(IPC.evidenceList, caseSlug),
    read: (evidenceId: number) => ipcRenderer.invoke(IPC.evidenceRead, evidenceId)
  },
  search: {
    query: (q: string, filters?: SearchFilters) => ipcRenderer.invoke(IPC.searchQuery, q, filters)
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
