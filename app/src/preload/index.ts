import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  NewCaseInput,
  SearchFilters,
  ApprovalDecision,
  CaseRecord,
  FileNode,
  FileReadResult,
  SessionSummary,
  ChatSearchResult
} from '../shared/types'
import type { AgentEvent } from '../shared/agent-events'
import type { SettingsPayload } from '../shared/settings'
import type { ConnectorsPayload } from '../shared/connectors'
import type { HealthCheckResult } from '../shared/health'
import type { SourceControlStatus } from '../shared/sourcecontrol'
import type { AgentAccessPayload } from '../shared/agentAccess'
import type { MemoryTopicsPayload, MemoryAuditEntry, SkillsPayload } from '../shared/memoryIpc'
import type {
  JiraAttachmentInfo,
  JiraAttachmentProgress,
  JiraIssuePreview,
  JiraRefreshSummary,
  JiraResult
} from '../shared/jira'
import type {
  BundleExportResult,
  BundleInspectResult,
  BundleImportResult,
  BundleWorkspaceRef
} from '../shared/bundle'
import type { HivemindPayload, HivemindPushResult } from '../shared/hivemind'
import type { ProposalsPayload } from '../shared/proposals'

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
    },
    onParsing: (
      cb: (p: { slug: string; evidenceId: number; active: boolean }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        p: { slug: string; evidenceId: number; active: boolean }
      ): void => cb(p)
      ipcRenderer.on(IPC.evidenceParsing, listener)
      return () => ipcRenderer.removeListener(IPC.evidenceParsing, listener)
    }
  },
  files: {
    list: (slug: string): Promise<FileNode[]> => ipcRenderer.invoke(IPC.filesList, slug),
    read: (slug: string, relPath: string): Promise<FileReadResult> =>
      ipcRenderer.invoke(IPC.filesRead, slug, relPath),
    open: (slug: string, relPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.filesOpen, slug, relPath),
    reveal: (slug: string, relPath?: string): Promise<void> =>
      ipcRenderer.invoke(IPC.filesReveal, slug, relPath),
    onChanged: (cb: (slug: string) => void): (() => void) => {
      const listener = (_e: unknown, slug: string): void => cb(slug)
      ipcRenderer.on(IPC.filesChanged, listener)
      return () => ipcRenderer.removeListener(IPC.filesChanged, listener)
    }
  },
  search: {
    query: (q: string, filters?: SearchFilters) => ipcRenderer.invoke(IPC.searchQuery, q, filters)
  },
  chat: {
    search: (caseSlug: string, q: string): Promise<ChatSearchResult> =>
      ipcRenderer.invoke(IPC.chatSearch, caseSlug, q)
  },
  agent: {
    send: (caseSlug: string, sessionId: number, text: string) =>
      ipcRenderer.invoke(IPC.agentSend, caseSlug, sessionId, text),
    interrupt: (caseSlug: string, sessionId: number) =>
      ipcRenderer.invoke(IPC.agentInterrupt, caseSlug, sessionId),
    respond: (caseSlug: string, sessionId: number, d: ApprovalDecision) =>
      ipcRenderer.invoke(IPC.agentRespond, caseSlug, sessionId, d),
    authStatus: (force?: boolean) => ipcRenderer.invoke(IPC.agentAuthStatus, force),
    history: (caseSlug: string, sessionId: number): Promise<AgentEvent[]> =>
      ipcRenderer.invoke(IPC.agentHistory, caseSlug, sessionId),
    preflight: () => ipcRenderer.invoke(IPC.agentPreflight),
    onEvent: (cb: (e: AgentEvent) => void): (() => void) => {
      const listener = (_e: unknown, ev: AgentEvent): void => cb(ev)
      ipcRenderer.on(IPC.agentEventChannel, listener)
      return () => ipcRenderer.removeListener(IPC.agentEventChannel, listener)
    }
  },
  sessions: {
    list: (caseSlug: string): Promise<SessionSummary[]> =>
      ipcRenderer.invoke(IPC.sessionsList, caseSlug),
    create: (caseSlug: string): Promise<SessionSummary> =>
      ipcRenderer.invoke(IPC.sessionsCreate, caseSlug),
    rename: (sessionId: number, title: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sessionsRename, sessionId, title)
  },
  workspaces: {
    pick: () => ipcRenderer.invoke(IPC.workspacesPick),
    link: (caseSlug: string, repoPath: string) =>
      ipcRenderer.invoke(IPC.workspacesLink, caseSlug, repoPath),
    unlink: (caseSlug: string, repoPath: string) =>
      ipcRenderer.invoke(IPC.workspacesUnlink, caseSlug, repoPath),
    list: (caseSlug: string) => ipcRenderer.invoke(IPC.workspacesList, caseSlug),
    refs: (caseSlug: string): Promise<BundleWorkspaceRef[]> =>
      ipcRenderer.invoke(IPC.workspacesRefs, caseSlug)
  },
  skills: {
    list: (): Promise<SkillsPayload> => ipcRenderer.invoke(IPC.skillsList)
  },
  bundle: {
    export: (caseSlug: string, includeTranscripts: boolean): Promise<BundleExportResult | null> =>
      ipcRenderer.invoke(IPC.bundleExport, caseSlug, includeTranscripts),
    inspect: (): Promise<BundleInspectResult | null> => ipcRenderer.invoke(IPC.bundleInspect),
    import: (zipPath: string, slug: string): Promise<BundleImportResult> =>
      ipcRenderer.invoke(IPC.bundleImport, zipPath, slug)
  },
  hivemind: {
    get: (): Promise<HivemindPayload> => ipcRenderer.invoke(IPC.hivemindGet),
    sync: (): Promise<HivemindPayload> => ipcRenderer.invoke(IPC.hivemindSync),
    install: (kind: 'skill' | 'reference', name: string): Promise<HivemindPayload> =>
      ipcRenderer.invoke(IPC.hivemindInstall, kind, name),
    claimReference: (name: string): Promise<HivemindPayload> =>
      ipcRenderer.invoke(IPC.hivemindClaimReference, name),
    diff: (kind: 'skill' | 'reference', name: string): Promise<string> =>
      ipcRenderer.invoke(IPC.hivemindDiff, kind, name),
    pushPreview: (kind: 'skill' | 'reference', name: string): Promise<string> =>
      ipcRenderer.invoke(IPC.hivemindPushPreview, kind, name),
    push: (kind: 'skill' | 'reference', name: string, title: string): Promise<HivemindPushResult> =>
      ipcRenderer.invoke(IPC.hivemindPush, kind, name, title)
  },
  proposals: {
    list: (): Promise<ProposalsPayload> => ipcRenderer.invoke(IPC.proposalsList),
    accept: (file: string): Promise<ProposalsPayload> =>
      ipcRenderer.invoke(IPC.proposalsAccept, file),
    reject: (file: string): Promise<ProposalsPayload> =>
      ipcRenderer.invoke(IPC.proposalsReject, file)
  },
  access: {
    get: (): Promise<AgentAccessPayload> => ipcRenderer.invoke(IPC.accessGet),
    patch: (p: unknown): Promise<AgentAccessPayload> => ipcRenderer.invoke(IPC.accessPatch, p),
    onChanged: (cb: (p: AgentAccessPayload) => void): (() => void) => {
      const listener = (_e: unknown, p: AgentAccessPayload): void => cb(p)
      ipcRenderer.on(IPC.accessChanged, listener)
      return () => ipcRenderer.removeListener(IPC.accessChanged, listener)
    }
  },
  memory: {
    topics: (): Promise<MemoryTopicsPayload> => ipcRenderer.invoke(IPC.memoryTopics),
    read: (name: string): Promise<string> => ipcRenderer.invoke(IPC.memoryRead, name),
    write: (name: string, content: string): Promise<MemoryTopicsPayload> =>
      ipcRenderer.invoke(IPC.memoryWrite, name, content),
    remove: (name: string): Promise<MemoryTopicsPayload> =>
      ipcRenderer.invoke(IPC.memoryDelete, name),
    audit: (): Promise<MemoryAuditEntry[]> => ipcRenderer.invoke(IPC.memoryAudit)
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
  jira: {
    preview: (key: string): Promise<JiraResult<JiraIssuePreview>> =>
      ipcRenderer.invoke(IPC.jiraPreview, key),
    createCase: (input: {
      slug: string
      title: string
      key: string
    }): Promise<JiraResult<CaseRecord>> => ipcRenderer.invoke(IPC.jiraCreateCase, input),
    ingestAttachments: (
      caseSlug: string,
      attachments: JiraAttachmentInfo[]
    ): Promise<JiraResult<JiraAttachmentProgress[]>> =>
      ipcRenderer.invoke(IPC.jiraIngestAttachments, caseSlug, attachments),
    refreshCase: (caseSlug: string): Promise<JiraResult<JiraRefreshSummary>> =>
      ipcRenderer.invoke(IPC.jiraRefreshCase, caseSlug),
    onAttachmentProgress: (cb: (p: JiraAttachmentProgress) => void): (() => void) => {
      const listener = (_e: unknown, p: JiraAttachmentProgress): void => cb(p)
      ipcRenderer.on(IPC.jiraAttachmentProgress, listener)
      return () => ipcRenderer.removeListener(IPC.jiraAttachmentProgress, listener)
    }
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
  sourceControl: {
    status: (): Promise<SourceControlStatus> => ipcRenderer.invoke(IPC.sourceControlStatus)
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
