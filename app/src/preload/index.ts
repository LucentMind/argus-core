import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'
import { IPC } from '../shared/ipc'
import { cleanIpcErrorMessage } from '../shared/ipcError'
import type {
  NewCaseInput,
  SearchFilters,
  ApprovalDecision,
  CaseRecord,
  CaseResolution,
  CaseStatus,
  DialogAnswer,
  FileNode,
  FileReadResult,
  ProviderStatus,
  EvidenceRecord,
  SessionSummary,
  ChatSearchResult,
  UnifiedHit,
  ArtifactTypeMeta,
  GraphStatusRow,
  GraphProgress,
  ScanSummary
} from '../shared/types'
import type { AgentEvent } from '../shared/agent-events'
import type { SettingsPayload, PermissionMode } from '../shared/settings'
import type { RunOptionSelection, ModelOptionInfo } from '../shared/runOptions'
import type { ConnectorsPayload } from '../shared/connectors'
import type { HealthCheckResult } from '../shared/health'
import type { DiagnosticsSnapshot } from '../shared/diagnostics'
import type {
  CorpusInfo,
  CorpusSearchInput,
  CorpusSyncStatus,
  SourceSearchResult
} from '../shared/defectCorpus'
import type { SourceControlStatus } from '../shared/sourcecontrol'
import type { AgentAccessPayload } from '../shared/agentAccess'
import type {
  MemoryTopicsPayload,
  MemoryAuditEntry,
  SkillsPayload,
  SkillsWriteResult,
  SkillReadPayload,
  SkillListItem
} from '../shared/memoryIpc'
import type {
  PromptCatalogPayload,
  PromptPreview,
  PromptCaptureListPayload,
  PromptCaptureDetail
} from '../shared/promptsIpc'
import type { DistillEvalExportResult } from '../shared/distillEval'
import type {
  JiraAttachmentInfo,
  JiraAttachmentProgress,
  JiraIssuePreview,
  JiraRefreshSummary,
  JiraResult,
  JiraSyncAllSummary
} from '../shared/jira'
import type {
  BundleExportResult,
  BundleInspectResult,
  BundleImportResult,
  BundleWorkspaceRef
} from '../shared/bundle'
import type {
  HivemindCheckResult,
  HivemindPayload,
  HivemindPushResult,
  LocalDivergence
} from '../shared/hivemind'
import type {
  AcceptedTarget,
  ProposalCounts,
  ProposalsPayload,
  RejectReason
} from '../shared/proposals'
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
  ReviewState,
  UsageStatsPayload
} from '../shared/observability'
import type { PacksListPayload, InspectResult, InstallResult, RepoPackRow } from '../shared/packs'
import type { CoreUpdatePayload, UpdateStatus } from '../shared/updates'
import type { SeedSampleResult } from '../shared/onboarding'
import type { PrBinding, PrRef, PrSearchResult } from '../shared/pr'
import type { ReviewRunComposition } from '../shared/reviewCompose'
import type { PrStatus } from '../shared/prStatus'
import type {
  OpenPanelRequest,
  PanelInfo,
  PanelKey,
  PanelDecl,
  PanelRect,
  ExternalAppInfo
} from '../shared/panels'
import type { DistillJobRow, SummarySearchHit, DistillStatusPayload } from '../shared/distill'
import type { SnippetResult, RepoSnippetResult, RepoTextResult } from '../shared/snippets'
import type { ModeId } from '../shared/modes'
import type { EvidenceScope } from '../shared/evidenceScope'
import type { AuthoringRequest, AuthoringResult } from '../shared/authoringIpc'
import {
  EDITOR_IPC,
  type EditorOpenRequest,
  type DraftChange,
  type DraftRecord,
  type DraftRef,
  type DraftSaved,
  type DraftAdoptRequest,
  type PersistedTabs,
  type FindReferencesRequest
} from '../shared/editorIpc'
import type { CorpusItem, ReferenceHit } from '../shared/corpusSearch'
import type {
  TextDocSource,
  TextDocOpenResult,
  TextDocLines,
  TextDocSearchEvent
} from '../shared/textdoc'

/**
 * Every channel on this bridge goes through here instead of `ipcRenderer.invoke` directly.
 *
 * Electron does not reject with the error main threw: it rejects with a new plain Error whose
 * message is `Error invoking remote method '<channel>': <the main error, stringified>`. That
 * prefix is IPC plumbing no user should ever read, and it reached the UI verbatim — 38 renderer
 * sites render a caught `.message` straight into the DOM, so a leak on any one of the ~190
 * channels here becomes a red string on screen (the `review:compose-run-prompt` "no PR bound"
 * report is the one that surfaced it). Electron adds the wrapper in exactly one place, so it is
 * stripped in exactly one place rather than at call sites that must then be audited forever.
 *
 * The error object is mutated and rethrown rather than replaced, so the stack survives for
 * devtools. Signature deliberately mirrors `ipcRenderer.invoke`'s own so this stayed a
 * mechanical substitution across every channel with no change to any inferred bridge type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function invoke(channel: string, ...args: any[]): Promise<any> {
  try {
    return await ipcRenderer.invoke(channel, ...args)
  } catch (err) {
    if (err instanceof Error) err.message = cleanIpcErrorMessage(err.message)
    throw err
  }
}

// Custom API for renderer
const argus = {
  cases: {
    create: (input: NewCaseInput) => invoke(IPC.casesCreate, input),
    list: () => invoke(IPC.casesList),
    cost: (caseSlug: string) => invoke(IPC.caseCost, caseSlug),
    readFindings: (caseSlug: string) => invoke(IPC.caseReadFindings, caseSlug),
    delete: (slug: string): Promise<void> => invoke(IPC.casesDelete, slug),
    setStatus: (slug: string, status: CaseStatus, resolution: CaseResolution | null) =>
      invoke(IPC.casesSetStatus, slug, status, resolution),
    /** Switch the case's active mode, creating (or resuming) that mode's chat. */
    setMode: (caseSlug: string, mode: ModeId): Promise<{ sessionId: number }> =>
      invoke(IPC.casesSetMode, caseSlug, mode)
  },
  evidence: {
    ingest: (caseSlug: string, absPaths: string[]) =>
      invoke(IPC.evidenceIngest, caseSlug, absPaths),
    ingestContent: (
      caseSlug: string,
      fileName: string,
      bytes: Uint8Array
    ): Promise<{ record: EvidenceRecord; deduped: boolean }> =>
      invoke(IPC.evidenceIngestContent, caseSlug, fileName, bytes),
    list: (caseSlug: string, scope?: EvidenceScope): Promise<EvidenceRecord[]> =>
      invoke(IPC.evidenceList, caseSlug, scope),
    read: (evidenceId: number, focusLine?: number) =>
      invoke(IPC.evidenceRead, evidenceId, focusLine),
    readSnippet: (
      caseSlug: string,
      relPath: string,
      line: number,
      end?: number
    ): Promise<SnippetResult> => invoke(IPC.evidenceReadSnippet, caseSlug, relPath, line, end),
    delete: (
      caseSlug: string,
      evidenceId: number
    ): Promise<{ deleted: Array<{ id: number; relPath: string; sha256: string }> }> =>
      invoke(IPC.evidenceDelete, caseSlug, evidenceId),
    scan: (caseSlug: string, mode?: ModeId): Promise<ScanSummary> =>
      invoke(IPC.evidenceScan, caseSlug, mode),
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
  textdoc: {
    open: (source: TextDocSource): Promise<TextDocOpenResult> => invoke(IPC.textdocOpen, source),
    lines: (source: TextDocSource, from: number, to: number): Promise<TextDocLines> =>
      invoke(IPC.textdocLines, source, from, to),
    search: (
      searchId: string,
      source: TextDocSource,
      query: string,
      opts: {
        regex?: boolean
        caseSensitive?: boolean
        fromLine?: number
        toLine?: number
        filter?: { query: string; regex?: boolean; caseSensitive?: boolean }
      }
    ): Promise<void> => invoke(IPC.textdocSearch, searchId, source, query, opts),
    cancelSearch: (searchId: string): Promise<void> => invoke(IPC.textdocCancelSearch, searchId),
    onSearchHits: (cb: (e: TextDocSearchEvent) => void): (() => void) => {
      const listener = (_e: unknown, ev: TextDocSearchEvent): void => cb(ev)
      ipcRenderer.on(IPC.textdocSearchHits, listener)
      return () => ipcRenderer.removeListener(IPC.textdocSearchHits, listener)
    },
    onIndexProgress: (cb: (p: { key: string; fraction: number }) => void): (() => void) => {
      const listener = (_e: unknown, p: { key: string; fraction: number }): void => cb(p)
      ipcRenderer.on(IPC.textdocIndexProgress, listener)
      return () => ipcRenderer.removeListener(IPC.textdocIndexProgress, listener)
    }
  },
  files: {
    list: (slug: string): Promise<FileNode[]> => invoke(IPC.filesList, slug),
    read: (slug: string, relPath: string): Promise<FileReadResult> =>
      invoke(IPC.filesRead, slug, relPath),
    open: (slug: string, relPath: string): Promise<void> => invoke(IPC.filesOpen, slug, relPath),
    reveal: (slug: string, relPath?: string): Promise<void> =>
      invoke(IPC.filesReveal, slug, relPath),
    onChanged: (cb: (slug: string) => void): (() => void) => {
      const listener = (_e: unknown, slug: string): void => cb(slug)
      ipcRenderer.on(IPC.filesChanged, listener)
      return () => ipcRenderer.removeListener(IPC.filesChanged, listener)
    }
  },
  packs: {
    artifactMeta: (): Promise<ArtifactTypeMeta[]> => invoke(IPC.packsArtifactMeta),
    referenceRouting: (): Promise<RoutingRule[]> => invoke(IPC.packsReferenceRouting),
    list: (): Promise<PacksListPayload> => invoke(IPC.packsList),
    pickBundle: (): Promise<string | null> => invoke(IPC.packsPickBundle),
    inspect: (source: string): Promise<InspectResult> => invoke(IPC.packsInspect, source),
    inspectRepo: (
      ref: string
    ): Promise<{ ok: true; packs: RepoPackRow[] } | { ok: false; error: string }> =>
      invoke(IPC.packsInspectRepo, ref),
    installFromRepo: (ref: string, packId: string): Promise<InstallResult> =>
      invoke(IPC.packsInstallFromRepo, ref, packId),
    install: (source: string): Promise<InstallResult> => invoke(IPC.packsInstall, source),
    uninstall: (id: string): Promise<{ ok: boolean; error?: string }> =>
      invoke(IPC.packsUninstall, id),
    relaunch: (): Promise<void> => invoke(IPC.packsRelaunch),
    checkUpdates: (): Promise<Record<string, UpdateStatus>> => invoke(IPC.packsCheckUpdates),
    applyUpdate: (id: string): Promise<UpdateStatus> => invoke(IPC.packsApplyUpdate, id),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.packsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.packsChanged, listener)
    }
  },
  update: {
    status: (): Promise<CoreUpdatePayload> => invoke(IPC.updateStatus),
    check: (): Promise<CoreUpdatePayload> => invoke(IPC.updateCheck),
    download: (): Promise<CoreUpdatePayload> => invoke(IPC.updateDownload),
    restart: (): Promise<CoreUpdatePayload> => invoke(IPC.updateRestart),
    onChanged: (cb: (p: CoreUpdatePayload) => void): (() => void) => {
      const listener = (_e: unknown, p: CoreUpdatePayload): void => cb(p)
      ipcRenderer.on(IPC.updateChanged, listener)
      return () => ipcRenderer.removeListener(IPC.updateChanged, listener)
    }
  },
  panels: {
    list: (caseSlug?: string): Promise<PanelInfo[]> => invoke(IPC.panelsList, caseSlug),
    open: (req: OpenPanelRequest): Promise<PanelInfo> => invoke(IPC.panelsOpen, req),
    close: (key: PanelKey): Promise<void> => invoke(IPC.panelsClose, key),
    focus: (key: PanelKey): Promise<void> => invoke(IPC.panelsFocus, key),
    popOut: (key: PanelKey): Promise<void> => invoke(IPC.panelsPopOut, key),
    dockBack: (key: PanelKey): Promise<void> => invoke(IPC.panelsDockBack, key),
    setTheme: (theme: 'dark' | 'light'): Promise<void> => invoke(IPC.panelsSetTheme, theme),
    decls: (): Promise<PanelDecl[]> => invoke(IPC.panelsDecls),
    setBounds: (key: PanelKey, rect: PanelRect): Promise<void> =>
      invoke(IPC.panelsSetBounds, key, rect),
    setVisible: (key: PanelKey, visible: boolean): Promise<void> =>
      invoke(IPC.panelsSetVisible, key, visible),
    closeCase: (caseSlug: string): Promise<void> => invoke(IPC.panelsCloseCase, caseSlug),
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
    list: (caseSlug?: string): Promise<ExternalAppInfo[]> => invoke(IPC.externalAppsList, caseSlug),
    open: (req: {
      caseSlug: string
      sessionId: number | null
      packId: string
      windowId: string
    }): Promise<unknown> => invoke(IPC.externalAppsOpen, req),
    stop: (key: PanelKey): Promise<void> => invoke(IPC.externalAppsStop, key)
  },
  distill: {
    status: (slug: string): Promise<DistillJobRow | null> => invoke(IPC.distillStatus, slug),
    retry: (jobId: number): Promise<DistillJobRow> => invoke(IPC.distillRetry, jobId),
    redistill: (slug: string): Promise<DistillJobRow> => invoke(IPC.distillRedistill, slug),
    similar: (slug: string): Promise<SummarySearchHit[]> => invoke(IPC.distillSimilar, slug),
    onChanged: (cb: (p: DistillStatusPayload) => void): (() => void) => {
      const listener = (_e: unknown, p: DistillStatusPayload): void => cb(p)
      ipcRenderer.on(IPC.distillChanged, listener)
      return () => ipcRenderer.removeListener(IPC.distillChanged, listener)
    }
  },
  search: {
    query: (q: string, filters?: SearchFilters): Promise<UnifiedHit[]> =>
      invoke(IPC.searchQuery, q, filters)
  },
  chat: {
    search: (caseSlug: string, q: string): Promise<ChatSearchResult> =>
      invoke(IPC.chatSearch, caseSlug, q)
  },
  agent: {
    send: (caseSlug: string, sessionId: number, text: string, composed?: boolean) =>
      invoke(IPC.agentSend, caseSlug, sessionId, text, composed),
    interrupt: (caseSlug: string, sessionId: number) =>
      invoke(IPC.agentInterrupt, caseSlug, sessionId),
    respond: (caseSlug: string, sessionId: number, d: ApprovalDecision) =>
      invoke(IPC.agentRespond, caseSlug, sessionId, d),
    answerDialog: (caseSlug: string, sessionId: number, a: DialogAnswer) =>
      invoke(IPC.agentAnswerDialog, caseSlug, sessionId, a),
    authStatus: (force?: boolean) => invoke(IPC.agentAuthStatus, force),
    onAuthChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.agentAuthChanged, listener)
      return () => ipcRenderer.removeListener(IPC.agentAuthChanged, listener)
    },
    history: (caseSlug: string, sessionId: number): Promise<AgentEvent[]> =>
      invoke(IPC.agentHistory, caseSlug, sessionId),
    preflight: () => invoke(IPC.agentPreflight),
    onEvent: (cb: (e: AgentEvent) => void): (() => void) => {
      const listener = (_e: unknown, ev: AgentEvent): void => cb(ev)
      ipcRenderer.on(IPC.agentEventChannel, listener)
      return () => ipcRenderer.removeListener(IPC.agentEventChannel, listener)
    }
  },
  sessions: {
    list: (caseSlug: string): Promise<SessionSummary[]> => invoke(IPC.sessionsList, caseSlug),
    create: (caseSlug: string): Promise<SessionSummary> => invoke(IPC.sessionsCreate, caseSlug),
    rename: (sessionId: number, title: string): Promise<void> =>
      invoke(IPC.sessionsRename, sessionId, title),
    /** Re-pin a chat to a provider instance + model. Resolves true when it actually changed. */
    setModel: (sessionId: number, instanceId: string, model: string): Promise<boolean> =>
      invoke(IPC.sessionsSetModel, sessionId, instanceId, model),
    /** Replace this chat's option selections. Resolves true when it actually changed. */
    setRunOptions: (sessionId: number, sel: RunOptionSelection[]): Promise<boolean> =>
      invoke(IPC.sessionsSetRunOptions, sessionId, sel),
    /** Pin this chat's permission mode. Resolves true when it actually changed. */
    setPermissionMode: (sessionId: number, mode: PermissionMode): Promise<boolean> =>
      invoke(IPC.sessionsSetPermissionMode, sessionId, mode),
    delete: (caseSlug: string, sessionId: number): Promise<void> =>
      invoke(IPC.sessionsDelete, caseSlug, sessionId)
  },
  models: {
    /** The option-bearing model catalog this instance's CLI reports. Empty for
     *  drivers with no runtime catalog. */
    catalog: (instanceId: string): Promise<ModelOptionInfo[]> =>
      invoke(IPC.modelsCatalog, instanceId)
  },
  modes: {
    /** The modes available to a case right now, given its current mode context. */
    available: (caseSlug: string): Promise<ModeId[]> => invoke(IPC.modesAvailable, caseSlug)
  },
  providers: {
    /** Per-instance provider status for the settings page. */
    statuses: (): Promise<ProviderStatus[]> => invoke(IPC.providerStatuses),
    /** Re-probe every enabled provider; resolves with the fresh list. */
    refresh: (): Promise<ProviderStatus[]> => invoke(IPC.providerRefresh),
    onChanged: (cb: () => void): (() => void) => {
      const h = (): void => cb()
      ipcRenderer.on(IPC.providersChanged, h)
      return () => ipcRenderer.removeListener(IPC.providersChanged, h)
    }
  },
  workspaces: {
    pick: () => invoke(IPC.workspacesPick),
    link: (caseSlug: string, repoPath: string) => invoke(IPC.workspacesLink, caseSlug, repoPath),
    unlink: (caseSlug: string, repoPath: string) =>
      invoke(IPC.workspacesUnlink, caseSlug, repoPath),
    list: (caseSlug: string) => invoke(IPC.workspacesList, caseSlug),
    refs: (caseSlug: string): Promise<BundleWorkspaceRef[]> => invoke(IPC.workspacesRefs, caseSlug),
    readSnippet: (
      caseSlug: string,
      repoName: string,
      relPath: string,
      start: number,
      end?: number,
      atSha?: string
    ): Promise<RepoSnippetResult> =>
      invoke(IPC.workspacesReadSnippet, caseSlug, repoName, relPath, start, end, atSha),
    readText: (
      caseSlug: string,
      repoName: string,
      relPath: string,
      focusStart: number
    ): Promise<RepoTextResult> =>
      invoke(IPC.workspacesReadText, caseSlug, repoName, relPath, focusStart),
    onChanged: (cb: (caseSlug: string) => void): (() => void) => {
      const listener = (_e: unknown, caseSlug: string): void => cb(caseSlug)
      ipcRenderer.on(IPC.workspacesChanged, listener)
      return () => ipcRenderer.removeListener(IPC.workspacesChanged, listener)
    }
  },
  pr: {
    // `input` is either free text (typed into the Repos rail, parsed in main) or an
    // already-resolved ref (a PR picker selection) — the handler tells them apart by shape.
    link: (caseSlug: string, input: string | PrRef): Promise<PrBinding> =>
      invoke(IPC.prLink, caseSlug, input),
    list: (caseSlug: string): Promise<PrBinding[]> => invoke(IPC.prList, caseSlug),
    unlink: (caseSlug: string, bindingId: number): Promise<void> =>
      invoke(IPC.prUnlink, caseSlug, bindingId),
    search: (caseSlug: string): Promise<PrSearchResult> => invoke(IPC.prSearch, caseSlug),
    statusList: (caseSlugs: string[]): Promise<Record<string, PrStatus>> =>
      invoke(IPC.prStatusList, caseSlugs),
    statusRefresh: (caseSlugs: string[]): Promise<Record<string, PrStatus>> =>
      invoke(IPC.prStatusRefresh, caseSlugs),
    onStatusChanged: (cb: (slugs: string[]) => void): (() => void) => {
      const h = (_e: unknown, slugs: string[]): void => cb(slugs)
      ipcRenderer.on(IPC.prStatusChanged, h)
      return () => ipcRenderer.removeListener(IPC.prStatusChanged, h)
    }
  },
  graph: {
    build: (
      repoPath: string,
      scope: string | null
    ): Promise<{ started: boolean; missing?: true }> => invoke(IPC.graphBuild, repoPath, scope),
    status: (repoPath: string): Promise<GraphStatusRow[]> => invoke(IPC.graphStatus, repoPath),
    install: (): Promise<{ ok: boolean; log: string }> => invoke(IPC.graphInstall),
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
    list: (): Promise<SkillsPayload> => invoke(IPC.skillsList),
    deleteUser: (name: string): Promise<SkillsPayload> => invoke(IPC.skillsDeleteUser, name),
    read: (name: string): Promise<SkillReadPayload> => invoke(IPC.skillsRead, name),
    write: (name: string, content: string, baseHash: string | null): Promise<SkillsWriteResult> =>
      invoke(IPC.skillsWrite, name, content, baseHash),
    fork: (name: string, newName?: string): Promise<{ name: string; skills: SkillListItem[] }> =>
      invoke(IPC.skillsFork, name, newName),
    /** Fires in every window when any of them writes a skill — the editor window included. */
    onChanged: (cb: (p: SkillsPayload) => void): (() => void) => {
      const listener = (_e: unknown, p: SkillsPayload): void => cb(p)
      ipcRenderer.on(IPC.skillsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.skillsChanged, listener)
    }
  },
  authoring: {
    draft: (req: AuthoringRequest): Promise<AuthoringResult> => invoke(IPC.authoringDraft, req),
    improve: (req: AuthoringRequest): Promise<AuthoringResult> => invoke(IPC.authoringImprove, req)
  },
  editor: {
    /** Open (or focus) the editor window on an asset. Callable from any window. */
    open: (req: EditorOpenRequest): Promise<void> => invoke(EDITOR_IPC.open, req),
    onOpenTab: (cb: (req: EditorOpenRequest) => void): (() => void) => {
      const h = (_e: unknown, req: EditorOpenRequest): void => cb(req)
      ipcRenderer.on(EDITOR_IPC.openTab, h)
      return () => {
        ipcRenderer.off(EDITOR_IPC.openTab, h)
      }
    },
    setDirty: (count: number): void => {
      ipcRenderer.send(EDITOR_IPC.dirtyState, count)
    },
    onCloseRequested: (cb: (info: { dirtyCount: number }) => void): (() => void) => {
      const h = (_e: unknown, info: { dirtyCount: number }): void => cb(info)
      ipcRenderer.on(EDITOR_IPC.closeRequested, h)
      return () => {
        ipcRenderer.off(EDITOR_IPC.closeRequested, h)
      }
    },
    respondClose: (allow: boolean): void => {
      ipcRenderer.send(EDITOR_IPC.closeResponse, allow)
    },
    /** Fire-and-forget: main owns the debounce, so the renderer never waits on a write. */
    draftChanged: (change: DraftChange): void => {
      ipcRenderer.send(EDITOR_IPC.draftChanged, change)
    },
    onDraftSaved: (cb: (saved: DraftSaved) => void): (() => void) => {
      const h = (_e: unknown, saved: DraftSaved): void => cb(saved)
      ipcRenderer.on(EDITOR_IPC.draftSaved, h)
      return () => {
        ipcRenderer.off(EDITOR_IPC.draftSaved, h)
      }
    },
    readDraft: (ref: DraftRef): Promise<DraftRecord | null> => invoke(EDITOR_IPC.draftRead, ref),
    discardDraft: (ref: DraftRef): Promise<void> => invoke(EDITOR_IPC.draftDiscard, ref),
    listDrafts: (): Promise<DraftRecord[]> => invoke(EDITOR_IPC.draftList),
    /** Atomic legacy-draft adoption, done in main (see `DraftStore.adopt`): the new key is
     *  written before the old one is discarded, so a crash mid-adoption leaves both rather than
     *  neither. Resolves `true` once the write actually landed. */
    adoptDraft: (req: DraftAdoptRequest): Promise<boolean> => invoke(EDITOR_IPC.draftAdopt, req),
    /** Fire-and-forget: main owns the debounce, so the renderer never waits on a write. */
    tabsChanged: (tabs: PersistedTabs): void => {
      ipcRenderer.send(EDITOR_IPC.tabsChanged, tabs)
    },
    onRestoreTabs: (cb: (tabs: PersistedTabs) => void): (() => void) => {
      const h = (_e: unknown, tabs: PersistedTabs): void => cb(tabs)
      ipcRenderer.on(EDITOR_IPC.restoreTabs, h)
      return () => {
        ipcRenderer.off(EDITOR_IPC.restoreTabs, h)
      }
    },
    /** Every asset quick open can offer (spec §6.2). Read on demand — main does not cache it. */
    corpus: (): Promise<CorpusItem[]> => invoke(EDITOR_IPC.corpus),
    findReferences: (req: FindReferencesRequest): Promise<ReferenceHit[]> =>
      invoke(EDITOR_IPC.findReferences, req)
  },
  bundle: {
    export: (caseSlug: string, includeTranscripts: boolean): Promise<BundleExportResult | null> =>
      invoke(IPC.bundleExport, caseSlug, includeTranscripts),
    inspect: (): Promise<BundleInspectResult | null> => invoke(IPC.bundleInspect),
    import: (zipPath: string, slug: string): Promise<BundleImportResult> =>
      invoke(IPC.bundleImport, zipPath, slug)
  },
  hivemind: {
    get: (): Promise<HivemindPayload> => invoke(IPC.hivemindGet),
    check: (): Promise<HivemindCheckResult> => invoke(IPC.hivemindCheck),
    sync: (): Promise<HivemindPayload> => invoke(IPC.hivemindSync),
    install: (
      kind: 'skill' | 'reference',
      name: string,
      opts?: { overwriteLocalEdits?: boolean }
    ): Promise<HivemindPayload> => invoke(IPC.hivemindInstall, kind, name, opts),
    uninstallSkill: (name: string): Promise<HivemindPayload> =>
      invoke(IPC.hivemindUninstallSkill, name),
    uninstallReference: (name: string): Promise<HivemindPayload> =>
      invoke(IPC.hivemindUninstallReference, name),
    claimReference: (name: string): Promise<HivemindPayload> =>
      invoke(IPC.hivemindClaimReference, name),
    diff: (kind: 'skill' | 'reference', name: string): Promise<string> =>
      invoke(IPC.hivemindDiff, kind, name),
    localDivergence: (name: string): Promise<LocalDivergence> =>
      invoke(IPC.hivemindLocalDivergence, name),
    pushPreview: (kind: 'skill' | 'reference', name: string): Promise<string> =>
      invoke(IPC.hivemindPushPreview, kind, name),
    push: (kind: 'skill' | 'reference', name: string, title: string): Promise<HivemindPushResult> =>
      invoke(IPC.hivemindPush, kind, name, title)
  },
  proposals: {
    list: (): Promise<ProposalsPayload> => invoke(IPC.proposalsList),
    accept: (
      file: string,
      editedContent?: string
    ): Promise<ProposalsPayload & { accepted: AcceptedTarget }> =>
      invoke(IPC.proposalsAccept, file, editedContent),
    reject: (file: string, reason?: RejectReason): Promise<ProposalsPayload> =>
      invoke(IPC.proposalsReject, file, reason),
    onChanged: (cb: (c: ProposalCounts) => void): (() => void) => {
      const listener = (_e: unknown, c: ProposalCounts): void => cb(c)
      ipcRenderer.on(IPC.proposalsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.proposalsChanged, listener)
    }
  },
  access: {
    get: (): Promise<AgentAccessPayload> => invoke(IPC.accessGet),
    patch: (p: unknown): Promise<AgentAccessPayload> => invoke(IPC.accessPatch, p),
    onChanged: (cb: (p: AgentAccessPayload) => void): (() => void) => {
      const listener = (_e: unknown, p: AgentAccessPayload): void => cb(p)
      ipcRenderer.on(IPC.accessChanged, listener)
      return () => ipcRenderer.removeListener(IPC.accessChanged, listener)
    }
  },
  refsync: {
    get: (): Promise<RefSyncPayload> => invoke(IPC.refsyncGet),
    validateSpace: (
      key: string
    ): Promise<JiraResult<{ space: ConfluenceSpace; root: TreeNodeVM }>> =>
      invoke(IPC.refsyncValidateSpace, key),
    children: (spaceKey: string, pageId: string): Promise<JiraResult<TreeNodeVM[]>> =>
      invoke(IPC.refsyncChildren, spaceKey, pageId),
    saveSpace: (space: unknown): Promise<RefSyncPayload> => invoke(IPC.refsyncSaveSpace, space),
    removeSpace: (key: string): Promise<RefSyncPayload> => invoke(IPC.refsyncRemoveSpace, key),
    sync: (key: string): Promise<JiraResult<SyncReport>> => invoke(IPC.refsyncSync, key),
    applyDrafts: (
      syncId: string,
      targets: string[]
    ): Promise<{ written: string[]; skipped: Array<{ target: string; reason: string }> }> =>
      invoke(IPC.refsyncApplyDrafts, syncId, targets),
    /** Remove references to pages that vanished upstream, for the approved targets. */
    prune: (
      syncId: string,
      targets: string[]
    ): Promise<{
      removed: string[]
      trimmed: string[]
      skipped: Array<{ target: string; reason: string }>
    }> => invoke(IPC.refsyncPrune, syncId, targets),
    readRef: (file: string): Promise<{ file: string; content: string; hash: string }> =>
      invoke(IPC.refsyncReadRef, file),
    writeRef: (file: string, content: string, baseHash: string | null): Promise<string> =>
      invoke(IPC.refsyncWriteRef, file, content, baseHash),
    searchRefs: (query: string): Promise<string[]> => invoke(IPC.refsyncSearchRefs, query),
    deleteRef: (file: string): Promise<void> => invoke(IPC.refsyncDeleteRef, file),
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
    topics: (): Promise<MemoryTopicsPayload> => invoke(IPC.memoryTopics),
    read: (name: string): Promise<string> => invoke(IPC.memoryRead, name),
    write: (name: string, content: string): Promise<MemoryTopicsPayload> =>
      invoke(IPC.memoryWrite, name, content),
    remove: (name: string): Promise<MemoryTopicsPayload> => invoke(IPC.memoryDelete, name),
    audit: (): Promise<MemoryAuditEntry[]> => invoke(IPC.memoryAudit),
    archive: (name: string): Promise<MemoryTopicsPayload> => invoke(IPC.memoryArchive, name),
    restore: (name: string): Promise<MemoryTopicsPayload> => invoke(IPC.memoryRestore, name)
  },
  /** Dev-only prompt surface. Exposed unconditionally — main enforces the gate, so a build
   *  without it rejects these calls rather than hiding the bridge. */
  devPrompts: {
    catalog: (): Promise<PromptCatalogPayload> => invoke(IPC.devPromptsCatalog),
    preview: (mode: string): Promise<PromptPreview> => invoke(IPC.devPromptsPreview, mode),
    setOverride: (id: string, text: string): Promise<PromptCatalogPayload> =>
      invoke(IPC.devPromptsSetOverride, id, text),
    clearOverride: (id: string): Promise<PromptCatalogPayload> =>
      invoke(IPC.devPromptsClearOverride, id),
    clearAll: (): Promise<PromptCatalogPayload> => invoke(IPC.devPromptsClearAll),
    overrides: (): Promise<string[]> => invoke(IPC.devPromptsOverrides),
    resolve: (id: string): Promise<string> => invoke(IPC.devPromptsResolve, id),
    captures: (): Promise<PromptCaptureListPayload> => invoke(IPC.devPromptsCaptures),
    capture: (caseSlug: string, sessionId: number): Promise<PromptCaptureDetail | null> =>
      invoke(IPC.devPromptsCapture, caseSlug, sessionId),
    exportDistillEval: (): Promise<DistillEvalExportResult | null> =>
      invoke(IPC.devPromptsExportDistillEval),
    onChanged: (cb: (ids: string[]) => void): (() => void) => {
      const listener = (_e: unknown, ids: string[]): void => cb(ids)
      ipcRenderer.on(IPC.devPromptsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.devPromptsChanged, listener)
    }
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    patch: (p: unknown) => invoke(IPC.settingsPatch, p),
    probeTools: () => invoke(IPC.settingsProbeTools),
    pickPath: (mode: 'file' | 'directory') => invoke(IPC.settingsPickPath, mode),
    reveal: (what: 'dataRoot' | 'settingsFile') => invoke(IPC.settingsReveal, what),
    setDataRoot: (): Promise<{ changed: boolean }> => invoke(IPC.settingsSetDataRoot),
    onChanged: (cb: (p: SettingsPayload) => void): (() => void) => {
      const listener = (_e: unknown, p: SettingsPayload): void => cb(p)
      ipcRenderer.on(IPC.settingsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.settingsChanged, listener)
    }
  },
  onboarding: {
    seedSample: (): Promise<SeedSampleResult> => invoke(IPC.onboardingSeedSample)
  },
  connectors: {
    get: () => invoke(IPC.connectorsGet),
    patch: (p: unknown) => invoke(IPC.connectorsPatch, p),
    test: (id: string) => invoke(IPC.connectorsTest, id),
    oauth: (id: string) => invoke(IPC.connectorsOauth, id),
    onChanged: (cb: (p: ConnectorsPayload) => void): (() => void) => {
      const listener = (_e: unknown, p: ConnectorsPayload): void => cb(p)
      ipcRenderer.on(IPC.connectorsChanged, listener)
      return () => ipcRenderer.removeListener(IPC.connectorsChanged, listener)
    }
  },
  secrets: {
    set: (name: string, value: string) => invoke(IPC.secretsSet, name, value),
    has: (name: string) => invoke(IPC.secretsHas, name),
    delete: (name: string) => invoke(IPC.secretsDelete, name)
  },
  jira: {
    preview: (key: string): Promise<JiraResult<JiraIssuePreview>> => invoke(IPC.jiraPreview, key),
    createCase: (input: {
      slug: string
      title: string
      key: string
    }): Promise<JiraResult<CaseRecord>> => invoke(IPC.jiraCreateCase, input),
    ingestAttachments: (
      caseSlug: string,
      attachments: JiraAttachmentInfo[]
    ): Promise<JiraResult<JiraAttachmentProgress[]>> =>
      invoke(IPC.jiraIngestAttachments, caseSlug, attachments),
    refreshCase: (caseSlug: string): Promise<JiraResult<JiraRefreshSummary>> =>
      invoke(IPC.jiraRefreshCase, caseSlug),
    markReviewed: (caseSlug: string): Promise<JiraResult<CaseRecord>> =>
      invoke(IPC.jiraMarkReviewed, caseSlug),
    setAttachmentSelection: (
      caseSlug: string,
      deselectedIds: string[]
    ): Promise<JiraResult<CaseRecord>> =>
      invoke(IPC.jiraSetAttachmentSelection, caseSlug, deselectedIds),
    openIssue: (caseSlug: string): Promise<void> => invoke(IPC.jiraOpenIssue, caseSlug),
    onAttachmentProgress: (cb: (p: JiraAttachmentProgress) => void): (() => void) => {
      const listener = (_e: unknown, p: JiraAttachmentProgress): void => cb(p)
      ipcRenderer.on(IPC.jiraAttachmentProgress, listener)
      return () => ipcRenderer.removeListener(IPC.jiraAttachmentProgress, listener)
    },
    syncAll: (): Promise<JiraResult<JiraSyncAllSummary>> => invoke(IPC.jiraSyncAll),
    onSyncProgress: (cb: (p: { done: number; total: number }) => void): (() => void) => {
      const listener = (_e: unknown, p: { done: number; total: number }): void => cb(p)
      ipcRenderer.on(IPC.jiraSyncProgress, listener)
      return () => ipcRenderer.removeListener(IPC.jiraSyncProgress, listener)
    }
  },
  health: {
    list: () => invoke(IPC.healthList),
    run: (ids?: string[]) => invoke(IPC.healthRun, ids),
    onResult: (cb: (r: HealthCheckResult) => void): (() => void) => {
      const listener = (_e: unknown, r: HealthCheckResult): void => cb(r)
      ipcRenderer.on(IPC.healthResult, listener)
      return () => ipcRenderer.removeListener(IPC.healthResult, listener)
    }
  },
  diagnostics: {
    latest: (): Promise<DiagnosticsSnapshot | null> => invoke(IPC.diagnosticsLatest),
    subscribe: (): Promise<void> => invoke(IPC.diagnosticsSubscribe),
    unsubscribe: (): Promise<void> => invoke(IPC.diagnosticsUnsubscribe),
    retrySidecar: (): Promise<void> => invoke(IPC.diagnosticsRetrySidecar),
    onSample: (cb: (s: DiagnosticsSnapshot) => void): (() => void) => {
      const listener = (_e: unknown, s: DiagnosticsSnapshot): void => cb(s)
      ipcRenderer.on(IPC.diagnosticsSample, listener)
      return () => ipcRenderer.removeListener(IPC.diagnosticsSample, listener)
    }
  },
  defects: {
    search: (req: CorpusSearchInput): Promise<SourceSearchResult[]> =>
      invoke(IPC.defectsSearch, req),
    test: (id: string): Promise<{ ok: true; info: CorpusInfo } | { ok: false; error: string }> =>
      invoke(IPC.defectsTest, id),
    syncNow: (id: string): Promise<{ ok: boolean; error?: string }> =>
      invoke(IPC.defectsSyncNow, id),
    syncStatus: (id: string): Promise<CorpusSyncStatus | null> => invoke(IPC.defectsSyncStatus, id)
  },
  sourceControl: {
    status: (): Promise<SourceControlStatus> => invoke(IPC.sourceControlStatus)
  },
  metrics: {
    global: (q?: MetricsQuery): Promise<GlobalMetrics> => invoke(IPC.metricsGlobal, q),
    case: (slug: string, q?: MetricsQuery): Promise<MetricsSummary> =>
      invoke(IPC.metricsCase, slug, q)
  },
  usage: {
    stats: (): Promise<UsageStatsPayload> => invoke(IPC.usageStats)
  },
  findings: {
    list: (slug: string): Promise<FindingRow[]> => invoke(IPC.findingsList, slug),
    review: (id: number, state: ReviewState): Promise<FindingRow | null> =>
      invoke(IPC.findingsReview, id, state),
    clear: (caseSlug: string, mode?: ModeId): Promise<{ cleared: number }> =>
      invoke(IPC.findingsClear, caseSlug, mode),
    delete: (id: number): Promise<{ deleted: true }> => invoke(IPC.findingsDelete, id)
  },
  review: {
    /** Resolves to a blocker report (not a rejection) for states the user can fix themselves. */
    composeRunPrompt: (
      slug: string,
      sessionId: number,
      layerIds: string[]
    ): Promise<ReviewRunComposition> =>
      invoke(IPC.reviewComposeRunPrompt, slug, sessionId, layerIds),
    composeActionPrompt: (
      slug: string,
      sessionId: number,
      findingIds: number[],
      action: 'comment' | 'apply'
    ): Promise<string> =>
      invoke(IPC.reviewComposeActionPrompt, slug, sessionId, findingIds, action),
    composeCiPrompt: (slug: string, sessionId: number, checkName: string): Promise<string> =>
      invoke(IPC.reviewComposeCiPrompt, slug, sessionId, checkName),
    postFindingComment: (
      slug: string,
      sessionId: number,
      findingId: number
    ): Promise<{ ok: boolean; reason?: string }> =>
      invoke(IPC.reviewPostFindingComment, slug, sessionId, findingId),
    /** The PR worktree's current head, for the findings pane's stale-finding chip. */
    worktreeHead: (slug: string): Promise<string | null> => invoke(IPC.reviewWorktreeHead, slug)
  },
  ui: {
    /** Scale the whole renderer UI uniformly (fonts, spacing, layout). */
    setZoomFactor: (factor: number): void => webFrame.setZoomFactor(factor),
    /** Report the same scale to main, so it can keep the native `titleBarOverlay` button
     *  hit-box sized to match — `setZoomFactor` above only scales the DOM. */
    setScale: (factor: number): Promise<void> => invoke(IPC.uiSetScale, factor),
    /** main → renderer: another window changed the theme; adopt it without re-persisting. */
    onThemeChanged: (cb: (theme: 'dark' | 'light') => void): (() => void) => {
      const listener = (_e: unknown, theme: 'dark' | 'light'): void => cb(theme)
      ipcRenderer.on(IPC.uiThemeChanged, listener)
      return () => {
        ipcRenderer.removeListener(IPC.uiThemeChanged, listener)
      }
    }
  },
  /** The header's own caption buttons (spec 2026-08-01-header-window-controls-design.md §3).
   *  The main window is built with no native `titleBarOverlay` on win32/linux, so these are the
   *  only way to minimize/maximize/close it there. */
  window: {
    minimize: () => invoke(IPC.windowMinimize),
    toggleMaximize: () => invoke(IPC.windowToggleMaximize),
    close: () => invoke(IPC.windowClose),
    isMaximized: (): Promise<boolean> => invoke(IPC.windowIsMaximized),
    /** main → renderer. Returns an unsubscribe function, like every other listener here. */
    onMaximizedChanged: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (_e: unknown, maximized: boolean): void => cb(maximized)
      ipcRenderer.on(IPC.windowMaximizedChanged, listener)
      return () => {
        ipcRenderer.removeListener(IPC.windowMaximizedChanged, listener)
      }
    }
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  openExternal: (url: string) => invoke(IPC.appOpenExternal, url),
  /** Three consumers: the CSS platform floors (`data-platform` in main.css) — the
   *  `.argus-titlebar-inset` rules around lines 426/489/498, and `:root[data-platform='darwin']
   *  .argus-header-inset` around line 454, the one `data-platform` rule this branch added and now
   *  the only one of the three that applies to the main window — that cannot otherwise tell a
   *  Windows build from a macOS one; `lib/platform.ts`'s `isDarwin()`, which decides whether TopBar
   *  renders Argus's own caption buttons at all; and `WindowControls`, which bails out entirely on
   *  darwin (the traffic lights are the OS's, not ours to draw). */
  platform: process.platform
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
