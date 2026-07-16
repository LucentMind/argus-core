import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  NewCaseInput,
  SearchFilters,
  ApprovalDecision,
  CaseRecord,
  CaseResolution,
  CaseStatus,
  FileNode,
  FileReadResult,
  SessionSummary,
  ChatSearchResult,
  UnifiedHit,
  ArtifactTypeMeta,
  GraphStatusRow,
  GraphProgress
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
import type { HivemindCheckResult, HivemindPayload, HivemindPushResult } from '../shared/hivemind'
import type { ProposalsPayload } from '../shared/proposals'
import type {
  RefSyncPayload,
  SyncReport,
  SyncProgress,
  TreeNodeVM,
  RoutingRule
} from '../shared/referenceSync'
import type { ConfluenceSpace } from '../shared/confluence'
import type {
  MetricsQuery,
  GlobalMetrics,
  MetricsSummary,
  FindingRow,
  ReviewState
} from '../shared/observability'
import type { PacksListPayload, InspectResult, InstallResult } from '../shared/packs'
import type { SeedSampleResult } from '../shared/onboarding'
import type {
  OpenPanelRequest,
  PanelInfo,
  PanelKey,
  PanelDecl,
  PanelRect,
  ExternalAppInfo
} from '../shared/panels'

// Custom API for renderer
const argus = {
  cases: {
    create: (input: NewCaseInput) => ipcRenderer.invoke(IPC.casesCreate, input),
    list: () => ipcRenderer.invoke(IPC.casesList),
    cost: (caseSlug: string) => ipcRenderer.invoke(IPC.caseCost, caseSlug),
    readFindings: (caseSlug: string) => ipcRenderer.invoke(IPC.caseReadFindings, caseSlug),
    delete: (slug: string): Promise<void> => ipcRenderer.invoke(IPC.casesDelete, slug),
    setStatus: (slug: string, status: CaseStatus, resolution: CaseResolution | null) =>
      ipcRenderer.invoke(IPC.casesSetStatus, slug, status, resolution)
  },
  evidence: {
    ingest: (caseSlug: string, absPaths: string[]) =>
      ipcRenderer.invoke(IPC.evidenceIngest, caseSlug, absPaths),
    list: (caseSlug: string) => ipcRenderer.invoke(IPC.evidenceList, caseSlug),
    read: (evidenceId: number, focusLine?: number) =>
      ipcRenderer.invoke(IPC.evidenceRead, evidenceId, focusLine),
    delete: (
      caseSlug: string,
      evidenceId: number
    ): Promise<{ deleted: Array<{ id: number; relPath: string; sha256: string }> }> =>
      ipcRenderer.invoke(IPC.evidenceDelete, caseSlug, evidenceId),
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
  packs: {
    artifactMeta: (): Promise<ArtifactTypeMeta[]> => ipcRenderer.invoke(IPC.packsArtifactMeta),
    referenceRouting: (): Promise<RoutingRule[]> => ipcRenderer.invoke(IPC.packsReferenceRouting),
    list: (): Promise<PacksListPayload> => ipcRenderer.invoke(IPC.packsList),
    pickBundle: (): Promise<string | null> => ipcRenderer.invoke(IPC.packsPickBundle),
    inspect: (source: string): Promise<InspectResult> =>
      ipcRenderer.invoke(IPC.packsInspect, source),
    install: (source: string): Promise<InstallResult> =>
      ipcRenderer.invoke(IPC.packsInstall, source),
    uninstall: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.packsUninstall, id),
    relaunch: (): Promise<void> => ipcRenderer.invoke(IPC.packsRelaunch),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.packsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.packsChanged, listener)
    }
  },
  panels: {
    list: (caseSlug?: string): Promise<PanelInfo[]> => ipcRenderer.invoke(IPC.panelsList, caseSlug),
    open: (req: OpenPanelRequest): Promise<PanelInfo> => ipcRenderer.invoke(IPC.panelsOpen, req),
    close: (key: PanelKey): Promise<void> => ipcRenderer.invoke(IPC.panelsClose, key),
    focus: (key: PanelKey): Promise<void> => ipcRenderer.invoke(IPC.panelsFocus, key),
    popOut: (key: PanelKey): Promise<void> => ipcRenderer.invoke(IPC.panelsPopOut, key),
    dockBack: (key: PanelKey): Promise<void> => ipcRenderer.invoke(IPC.panelsDockBack, key),
    setTheme: (theme: 'dark' | 'light'): Promise<void> =>
      ipcRenderer.invoke(IPC.panelsSetTheme, theme),
    decls: (): Promise<PanelDecl[]> => ipcRenderer.invoke(IPC.panelsDecls),
    setBounds: (key: PanelKey, rect: PanelRect): Promise<void> =>
      ipcRenderer.invoke(IPC.panelsSetBounds, key, rect),
    setVisible: (key: PanelKey, visible: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.panelsSetVisible, key, visible),
    closeCase: (caseSlug: string): Promise<void> =>
      ipcRenderer.invoke(IPC.panelsCloseCase, caseSlug),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.panelsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.panelsChanged, listener)
    },
    onActivate: (cb: (key: PanelKey) => void): (() => void) => {
      const listener = (_e: unknown, key: PanelKey): void => cb(key)
      ipcRenderer.on(IPC.panelsActivate, listener)
      return () => ipcRenderer.removeListener(IPC.panelsActivate, listener)
    },
    onCite: (
      cb: (p: { caseSlug: string; sessionId: number; relPath: string; line: number }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        p: { caseSlug: string; sessionId: number; relPath: string; line: number }
      ): void => cb(p)
      ipcRenderer.on(IPC.panelsCiteAdded, listener)
      return () => ipcRenderer.removeListener(IPC.panelsCiteAdded, listener)
    },
    onDraft: (
      cb: (p: { caseSlug: string; sessionId: number; text: string }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        p: { caseSlug: string; sessionId: number; text: string }
      ): void => cb(p)
      ipcRenderer.on(IPC.panelsDraft, listener)
      return () => ipcRenderer.removeListener(IPC.panelsDraft, listener)
    }
  },
  externalApps: {
    list: (caseSlug?: string): Promise<ExternalAppInfo[]> =>
      ipcRenderer.invoke(IPC.externalAppsList, caseSlug),
    open: (req: {
      caseSlug: string
      sessionId: number | null
      packId: string
      windowId: string
    }): Promise<unknown> => ipcRenderer.invoke(IPC.externalAppsOpen, req),
    stop: (key: PanelKey): Promise<void> => ipcRenderer.invoke(IPC.externalAppsStop, key)
  },
  search: {
    query: (q: string, filters?: SearchFilters): Promise<UnifiedHit[]> =>
      ipcRenderer.invoke(IPC.searchQuery, q, filters)
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
      ipcRenderer.invoke(IPC.sessionsRename, sessionId, title),
    delete: (caseSlug: string, sessionId: number): Promise<void> =>
      ipcRenderer.invoke(IPC.sessionsDelete, caseSlug, sessionId)
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
  graph: {
    build: (
      repoPath: string,
      scope: string | null
    ): Promise<{ started: boolean; missing?: true }> =>
      ipcRenderer.invoke(IPC.graphBuild, repoPath, scope),
    status: (repoPath: string): Promise<GraphStatusRow[]> =>
      ipcRenderer.invoke(IPC.graphStatus, repoPath),
    install: (): Promise<{ ok: boolean; log: string }> => ipcRenderer.invoke(IPC.graphInstall),
    onBuilding: (
      cb: (p: { repoPath: string; scope: string | null; active: boolean }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        p: { repoPath: string; scope: string | null; active: boolean }
      ): void => cb(p)
      ipcRenderer.on(IPC.graphBuilding, listener)
      return () => ipcRenderer.removeListener(IPC.graphBuilding, listener)
    },
    onChanged: (cb: (p: { repoPath: string }) => void): (() => void) => {
      const listener = (_e: unknown, p: { repoPath: string }): void => cb(p)
      ipcRenderer.on(IPC.graphChanged, listener)
      return () => ipcRenderer.removeListener(IPC.graphChanged, listener)
    },
    onProgress: (cb: (p: GraphProgress) => void): (() => void) => {
      const listener = (_e: unknown, p: GraphProgress): void => cb(p)
      ipcRenderer.on(IPC.graphProgress, listener)
      return () => ipcRenderer.removeListener(IPC.graphProgress, listener)
    }
  },
  skills: {
    list: (): Promise<SkillsPayload> => ipcRenderer.invoke(IPC.skillsList),
    deleteUser: (name: string): Promise<SkillsPayload> =>
      ipcRenderer.invoke(IPC.skillsDeleteUser, name)
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
    check: (): Promise<HivemindCheckResult> => ipcRenderer.invoke(IPC.hivemindCheck),
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
    accept: (file: string, editedContent?: string): Promise<ProposalsPayload> =>
      ipcRenderer.invoke(IPC.proposalsAccept, file, editedContent),
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
  refsync: {
    get: (): Promise<RefSyncPayload> => ipcRenderer.invoke(IPC.refsyncGet),
    validateSpace: (
      key: string
    ): Promise<JiraResult<{ space: ConfluenceSpace; root: TreeNodeVM }>> =>
      ipcRenderer.invoke(IPC.refsyncValidateSpace, key),
    children: (spaceKey: string, pageId: string): Promise<JiraResult<TreeNodeVM[]>> =>
      ipcRenderer.invoke(IPC.refsyncChildren, spaceKey, pageId),
    saveSpace: (space: unknown): Promise<RefSyncPayload> =>
      ipcRenderer.invoke(IPC.refsyncSaveSpace, space),
    removeSpace: (key: string): Promise<RefSyncPayload> =>
      ipcRenderer.invoke(IPC.refsyncRemoveSpace, key),
    sync: (key: string): Promise<JiraResult<SyncReport>> =>
      ipcRenderer.invoke(IPC.refsyncSync, key),
    applyDrafts: (
      syncId: string,
      targets: string[]
    ): Promise<{ written: string[]; skipped: Array<{ target: string; reason: string }> }> =>
      ipcRenderer.invoke(IPC.refsyncApplyDrafts, syncId, targets),
    readRef: (file: string): Promise<{ file: string; content: string }> =>
      ipcRenderer.invoke(IPC.refsyncReadRef, file),
    searchRefs: (query: string): Promise<string[]> =>
      ipcRenderer.invoke(IPC.refsyncSearchRefs, query),
    onChanged: (cb: (p: RefSyncPayload) => void): (() => void) => {
      const listener = (_e: unknown, p: RefSyncPayload): void => cb(p)
      ipcRenderer.on(IPC.refsyncChanged, listener)
      return () => ipcRenderer.removeListener(IPC.refsyncChanged, listener)
    },
    onProgress: (cb: (p: SyncProgress) => void): (() => void) => {
      const listener = (_e: unknown, p: SyncProgress): void => cb(p)
      ipcRenderer.on(IPC.refsyncProgress, listener)
      return () => ipcRenderer.removeListener(IPC.refsyncProgress, listener)
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
    setDataRoot: (): Promise<{ changed: boolean }> => ipcRenderer.invoke(IPC.settingsSetDataRoot),
    onChanged: (cb: (p: SettingsPayload) => void): (() => void) => {
      const listener = (_e: unknown, p: SettingsPayload): void => cb(p)
      ipcRenderer.on(IPC.settingsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.settingsChanged, listener)
    }
  },
  onboarding: {
    seedSample: (): Promise<SeedSampleResult> => ipcRenderer.invoke(IPC.onboardingSeedSample)
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
  metrics: {
    global: (q?: MetricsQuery): Promise<GlobalMetrics> => ipcRenderer.invoke(IPC.metricsGlobal, q),
    case: (slug: string, q?: MetricsQuery): Promise<MetricsSummary> =>
      ipcRenderer.invoke(IPC.metricsCase, slug, q)
  },
  findings: {
    list: (slug: string): Promise<FindingRow[]> => ipcRenderer.invoke(IPC.findingsList, slug),
    review: (id: number, state: ReviewState): Promise<FindingRow | null> =>
      ipcRenderer.invoke(IPC.findingsReview, id, state),
    clear: (caseSlug: string): Promise<{ cleared: number }> =>
      ipcRenderer.invoke(IPC.findingsClear, caseSlug)
  },
  ui: {
    /** Scale the whole renderer UI uniformly (fonts, spacing, layout). */
    setZoomFactor: (factor: number): void => webFrame.setZoomFactor(factor)
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
