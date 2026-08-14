import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  protocol,
  webContents,
  Tray,
  Menu,
  nativeImage,
  Notification
} from 'electron'
import fs from 'node:fs'
import path, { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { ZodError } from 'zod'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/argus-icon.png?asset'
import trayIconPng from '../../resources/trayIcon.png?asset'
import trayTemplatePng from '../../resources/trayTemplate.png?asset'
import { TrayService } from './services/tray'
import { shouldKeepAlive } from './services/keepAlive'
import { IPC } from '../shared/ipc'
import {
  resolveArgusHome,
  dbPath,
  caseDir,
  settingsPath,
  configDir,
  writeRootOverride
} from './services/paths'
import { topicEnabled } from '../shared/agentAccess'
import { openDb } from './services/db'
import { SettingsService } from './services/settings'
import { migrateBypassDefault, migrateDefaultRepoToList } from './services/settingsMigrations'
import { devToolsEnabled } from './services/prompts/gate'
import { readDevToolsUnlocked, writeDevToolsUnlocked } from './services/devToolsUnlock'
import { PromptCaptureStore } from './services/prompts/capture'
import { PromptStore } from './services/prompts/store'
import { assertDevTools } from './services/prompts/ipcGate'
import { overrideBootWarnings } from './services/prompts/bootWarnings'
import { buildPromptPreview } from './services/prompts/preview'
import { fillPrompt } from './services/prompts/fill'
import { buildCaptureDetail } from './services/prompts/captureDetail'
import { exportEvalBundle } from './services/distill/evalExport'
import { DefectCorpusService } from './services/defectCorpus/service'
import type { CorpusAdminConfig, CorpusSearchInput } from './services/defectCorpus/client'
import { corpusTokenSecret } from '../shared/defectCorpus'
import { RelatedHistoryService } from './services/relatedHistory'
import { validateRelatedSearchInput } from './services/relatedHistory/input'
import { attachCorpusEvidence } from './services/relatedHistory/attach'
import { pushScaleIfChanged, pushThemeIfChanged, type TitleBarTheme } from './services/titleBar'
import { mainWindowOptions } from './services/windowOptions'
import {
  closeWindow,
  isWindowFullScreen,
  isWindowMaximized,
  minimizeWindow,
  toggleMaximizeWindow
} from './services/windowControls'
import type {
  PromptCatalogPayload,
  PromptPreview,
  SessionPromptCapture,
  PromptCaptureListPayload,
  PromptCaptureDetail
} from '../shared/promptsIpc'
import type { DistillEvalExportResult } from '../shared/distillEval'
import { SecretStore } from './services/secrets'
import { ConnectorRegistry } from './services/connectors'
import { ToolRiskStore } from './services/toolRisk'
import { AgentAccessStore } from './services/agentAccess'
import {
  listTopics,
  readIndex,
  readTopic,
  writeTopicFile,
  deleteTopic,
  readAudit,
  MEMORY_INDEX_MAX_LINES,
  MEMORY_TOPIC_MAX_BYTES
} from './services/memory'
import { archiveTopic, restoreTopic } from './services/memoryHygiene'
import {
  deleteUserSkill,
  readSkill,
  resolveSkills,
  writeUserSkill,
  forkSkill,
  userSkillShadowDiverged
} from './services/agent/skillsResolver'
import { scanClaudeSkills, importSkills } from './services/agent/skillsImport'
import { HivemindService } from './services/hivemind'
import {
  listProposals,
  acceptProposal,
  rejectProposal,
  setProposalsChangedNotifier,
  proposalCounts
} from './services/proposals'
import { identity } from './services/authorship'
import type { RejectReason } from '../shared/proposals'
import type {
  MemoryTopicsPayload,
  SkillsPayload,
  SkillImportSource,
  SkillImportItem
} from '../shared/memoryIpc'
import { loadPresets, isOpenableUrl } from './services/presets'
import { McpService } from './services/mcp'
import { McpOAuth } from './services/oauth'
import { HealthService } from './services/health'
import { hydratePathFromLoginShell } from './services/shellPath'
import { ghStatus } from './services/sourceControl'
import {
  AtlassianClient,
  AtlassianError,
  atlassianRestConfigured,
  rovoInstanceId,
  jiraBrowseUrl,
  resolveAtlassianCreds,
  type AtlassianAuth
} from './services/atlassian'
import { JiraCases } from './services/jiraCases'
import { buildJiraScopeResolver } from './services/jiraScopeResolver'
import type { JiraAttachmentInfo, JiraResult } from '../shared/jira'
import {
  connectorConfig,
  type ConnectorsPayload,
  type HttpConnectorConfig
} from '../shared/connectors'
import {
  createCase,
  listCases,
  deleteCase,
  setCaseStatus,
  setCaseJiraDeselected,
  setCaseMode,
  getCase
} from './services/caseService'
import { OnboardingService, resolveSampleAssetsDir } from './services/onboarding'
import {
  ingestArtifact,
  ingestBytes,
  listEvidence,
  deleteEvidence,
  getEvidenceRecord
} from './services/ingest'
import { extractDerivedText } from './services/extraction'
import { IngestQueue, requeuePendingIndexes } from './services/ingestQueue'
import { listCaseFiles, readCaseFile, resolveCasePath, assertSlug } from './services/caseFiles'
import { createCaseWatchHub } from './services/caseWatch'
import { createProposalsWatch } from './services/proposalsWatch'
import { scanEvidence } from './services/scan'
import { searchEvidenceWithStatus, readEvidenceText, readEvidenceSnippet } from './services/search'
import { openTextDoc, readTextDocLines } from './services/textdoc'
import { TextDocSearchHub, type TextDocSearchOpts } from './services/textdocSearch'
import type { TextDocSource } from '../shared/textdoc'
import { searchMessages, searchAllMessages } from './services/chatSearch'
import { AgentService } from './services/agent/registry'
import { ownerKeyOf } from './services/agent/session'
import { buildReferenceIndex } from './services/agent/referenceIndex'
import { flattenPanelCommands } from './services/agent/panelCommands'
import {
  listSessions,
  createSession,
  setSessionModel,
  setSessionRunOptions,
  setSessionPermissionMode,
  assertPermissionMode,
  renameSession,
  deleteSession,
  sessionProvider,
  reconcilePermissionModeForDriver,
  sessionPermissionMode
} from './services/agent/sessionStore'
import { ModeRefusalRegistry, recordRefusalFor } from './services/agent/modeRefusals'
import { modeContextForCase, demoteIfModeUnavailable } from './services/modeContext'
import { availableModes, MODES, type ModeId } from '../shared/modes'
import type { EvidenceScope } from '../shared/evidenceScope'
import { SessionMirror, readSessionEvents } from './services/agent/mirror'
import {
  getActiveDriver,
  getDriverByKind,
  resolveDriver,
  resolveInstanceDriver
} from './services/agent/driverRegistry'
import { ProviderStatusService } from './services/agent/providerStatus'
import { createNpmVersionLookup } from './services/agent/npmVersion'
import { AuthCache } from './services/agent/authCache'
import {
  linkWorkspace,
  unlinkWorkspace,
  listWorkspaces,
  autoLinkDefaultRepo
} from './services/workspaces'
import {
  recordLink,
  listRecent,
  dismissPromote,
  shouldSuggestDefault,
  assertRepoPath,
  caseCount,
  repoKey
} from './services/repoUsage'
import { getBinding, listBindings, removeBinding } from './services/prBindings'
import { refreshPrStatuses, readPrStatuses } from './services/prStatusService'
import { linkPrForCase } from './services/prLink'
import { searchPrsForCase } from './services/prSearch'
import { ensurePrWorktree } from './services/prWorktree'
import type { PrMaterializer } from './services/prBindings'

/** The real checkout used by both materialization call sites (mode entry, picker confirm). */
function prMaterializer(argusHome: string, caseSlug: string): PrMaterializer {
  return (b) =>
    b.repoPath ? ensurePrWorktree(argusHome, caseSlug, b.repoPath, b.number) : Promise.resolve(null)
}
import type { PrRef } from '../shared/pr'
import { readRepoSnippet, readRepoText } from './services/workspaceRead'
import { exportCase, importCase, inspectBundle } from './services/bundle'
import {
  activeInstanceConfig,
  defaultModelRef,
  driverConfig,
  type AgentDriverConfig
} from '../shared/drivers'
import { defaultCreateQuery as createClaudeQuery } from './services/agent/drivers/claude'
import { fetchCatalog } from './services/agent/drivers/claude/catalog'
import { composeReviewRunPrompt } from './services/agent/reviewRunCompose'
import { composeReviewActionPrompt } from './services/agent/reviewActionCompose'
import { composeCiTriagePrompt } from './services/agent/ciTriageCompose'
import { prWorktreeHead } from './services/agent/reviewWrites'
import { ReferenceSyncStore } from './services/referenceSyncStore'
import { RefSyncService } from './services/refSync/service'
import { createHeadlessRunner } from './services/agent/headless'
import {
  seedSharedAssets,
  sharedSkillsDir,
  sharedReferencesDir,
  resolveCoreSkillsDir,
  detectSkillCollisions
} from './services/skillsDir'
import { PackRegistry } from './services/packs/registry'
import { createDetection } from './services/packs/detection'
import { capturePanelToEvidence, type CapturePanelEvidence } from './services/agent/capturePanel'
import { seededPacksDir, ensurePacksDir } from './services/packs/paths'
import { BinariesService } from './services/packs/binaries'
import { CodeGraphService, graphsRoot } from './services/codeGraph'
import { createExtractors } from './services/packs/extractors'
import { PacksStateStore } from './services/packs/packsState'
import { installPack, uninstallPack, inspectBundleSource } from './services/packs/install'
import { listInstalledPacks } from './services/packs/packsService'
import { PackUpdatesService, nodeHttpClient } from './services/packs/packUpdates'
import { nodeGhClient } from './services/packs/ghClient'
import { listRepoPacks, installFromRepo } from './services/packs/githubInstall'
import { parseGhRef } from './services/packs/githubRef'
import { registerPacksPlanIpc } from './services/packs/planIpc'
import { makeCandidateResolver, downloadCandidate } from './services/packs/depSources'
import type { InstallResult, RepoPackRow } from '../shared/packs'
import { autoUpdater } from 'electron-updater'
import { CoreUpdaterService, noopBackend } from './services/update/coreUpdater'
import { createElectronUpdaterBackend } from './services/update/electronUpdaterBackend'
import { registerUpdateIpc } from './services/update/updateIpc'
import type { UpdateStatus } from '../shared/updates'
import { PanelHost } from './services/panels/panelHost'
import { createElectronPanelFactory } from './services/panels/electronPlatform'
import { resolvePanelAsset, buildPanelCsp, type PanelWindowLoc } from './services/panels/protocol'
import { ExternalAppHost } from './services/panels/externalAppHost'
import { createElectronProcessSpawner } from './services/panels/electronProcessSpawner'
import type { OpenPanelRequest, PanelKey, PanelPermission, PanelRect } from '../shared/panels'
import {
  CASE_RESOLUTIONS,
  type ApprovalDecision,
  type CaseRecord,
  type CaseResolution,
  type CaseStatus,
  type DialogAnswer,
  type EvidenceRecord,
  type NewCaseInput,
  type SearchFilters,
  type UnifiedHit,
  type UnifiedSearchResult
} from '../shared/types'
import { globalMetrics, caseMetrics } from './services/observability/metrics'
import { LangfuseExporter } from './services/observability/langfuse'
import { LangfuseSink } from './services/observability/langfuseSink'
import { createLangfuseTracing } from './services/observability/langfuseTracing'
import { probeLangfuseCredentials } from './services/observability/langfuseProbe'
import { usageStats, ensureTrackingStarted } from './services/observability/usage'
import { listFindings, reviewFinding, clearFindings, deleteFinding } from './services/findings'
import type { MetricsQuery, ReviewState } from '../shared/observability'
import { DistillQueue, reconcileAndEnqueue, needsDistillRun } from './services/distill/queue'
import { assembleDistillInput } from './services/distill/input'
import { runCaseDistill } from './services/distill/caseDistiller'
import { stageDistillOutput } from './services/distill/staging'
import { searchCaseSummaries } from './services/distill/summaries'
import { caseDistillPromptHash } from './services/distill/promptHash'
import { RcaJobs } from './services/rca/jobs'
import { postRcaReport } from './services/rca/post'
import { assembleRcaInput } from './services/rca/input'
import { caseRcaPromptHash } from './services/rca/promptHash'
import {
  renderExecReport,
  renderTechReport,
  templateFromSnapshot,
  toIdSet
} from './services/rca/render'
import { validateRcaDraft } from './services/rca/parse'
import { readReportMarkdown, writeReportMarkdown } from './services/rca/artifacts'
import { handEditedReports } from './services/rca/handEdited'
import type { RoleAssignment, RcaDraft, CaseRcaInput, RcaDroppedSections } from '../shared/rca'
import { draftAsset, improveAsset } from './services/authoring/service'
import type { AuthoringRequest, AuthoringResult } from '../shared/authoringIpc'
import { EditorWindowService } from './services/editorWindow'
import { EditorWindowStore } from './services/editorWindowStore'
import { makeElectronEditorWindowFactory } from './services/electronEditorWindow'
import { DraftStore } from './services/drafts'
import {
  EDITOR_IPC,
  type EditorOpenRequest,
  type DraftChange,
  type DraftRef,
  type DraftAdoptRequest,
  type PersistedTabs,
  type FindReferencesRequest
} from '../shared/editorIpc'
import { EditorCorpusService } from './services/editorCorpus'
import os from 'node:os'
import {
  DiagnosticsService,
  SLOW_INTERVAL_MS,
  type SidecarClientLike
} from './services/diagnostics'
import { SidecarClient, createDisabledSidecarClient } from './services/diagnostics/sidecarClient'
import { createElectronSidecarSpawner } from './services/diagnostics/spawner'
import { resolveSidecarBinary } from './services/diagnostics/sidecarBinary'
import { defaultProcessLabels } from './services/diagnostics/processLabels'
import { Terminator } from './services/diagnostics/terminate'
import type { TerminateResult } from '../shared/diagnostics'
import {
  stdioConnectorCommands,
  type ConnectorCommand,
  type WindowDescriptor
} from './services/diagnostics/labels'
import {
  collectWindowDescriptors,
  type WindowSource
} from './services/diagnostics/windowDescriptors'
import { RoutineStore } from './services/routines/store'
import { RoutinesService } from './services/routines/service'
import { reconcileInterruptedRuns, runningRoutineForSession } from './services/routines/runs'
import { createRoutineTurnRunner } from './services/routines/turnRunner'
import { RoutineScheduler } from './services/routines/scheduler'
import type { ScopeResolver } from './services/routines/scopeResolver'
import { ROUTINE_TEMPLATES } from './services/routines/templates'
import type { RoutinesPayload, RoutineTemplate } from '../shared/routines'

let agentService: AgentService | null = null
let providerStatusService: ProviderStatusService | null = null
let langfuseExporter: LangfuseExporter | null = null
let mainWindow: BrowserWindow | null = null
let editorWindowService: EditorWindowService | null = null
// Module-scope for the same reason as draftStore below: registerIpc() constructs it, but
// `before-quit` lives out here and has to close the config/routines.json directory watcher.
let routineStore: RoutineStore | null = null
// Set when the tray's "N runs to review" item or a run-finished notification click has to create
// the main window: that window's webContents has no renderer listener yet, so a push broadcast
// right then would be silently dropped (the race `routines:focus-inbox` used to lose against
// App.tsx's `useEffect` subscription). Consumed once by `routines:consume-focus-inbox`, which
// App.tsx calls on mount instead of main guessing when the renderer is ready to hear a push.
let pendingFocusInbox = false
// Same reason as routineStore above: `before-quit` lives out here and has to clear the poll
// interval. A timer left running past quit keeps ticking against a closing database.
let routineScheduler: RoutineScheduler | null = null
// Module-scope for the same reason as routineScheduler above: `before-quit` lives out here and
// must destroy the tray. A leaked Tray handle is itself a reason a Windows process refuses to
// exit, which would turn a successful quit into a zombie.
let trayService: TrayService | null = null
// Published from registerIpc()'s local const (same idiom as routineStore): `window-all-closed`
// out here has to read the keep-alive setting, and it fires after registerIpc has long returned.
let appSettings: SettingsService | null = null
// Same reason as routineStore/routineScheduler above: `before-quit` lives out here and has to
// interrupt whatever routine is currently running — a background session never enters
// AgentService's map, so nothing else on the quit path reaches it.
let routinesServiceHandle: RoutinesService | null = null
/**
 * The theme main believes the UI is on. Windows are constructed before any renderer can report
 * one, so the first main window opens on this default and self-corrects the instant uiStore's
 * constructor fires `panels:set-theme` (see the handler that maintains this, Task 3). A light-
 * theme user gets one frame of dark-tinted system buttons; persisting the theme in main to close
 * that gap is more machinery than the flash is worth. An editor window opened later is already
 * correct, because it reads this after the first report has landed.
 */
let lastTheme: TitleBarTheme = 'dark'
/**
 * The UI zoom factor main believes the renderer is at. Same bootstrapping story as `lastTheme`
 * above, and the same default the renderer's `UI_SCALES` uses (`uiStore.ts`): windows are
 * constructed before any renderer can report a scale, so the first window opens unscaled and
 * self-corrects the instant `uiStore`'s constructor fires `ui:set-scale`.
 */
let lastScale = 1
// Module-scope, unlike the store it wraps: `before-quit` lives out here and must be able to
// flush. See the flush calls in createWindow()'s 'closed' handler and in before-quit.
let draftStore: DraftStore | null = null
// Module-scope for the same reason as draftStore above: `before-quit` and the main window's
// 'closed' handler both live outside registerIpc() and need to flush the tab set's debounce
// before the editor renderer is force-closed.
let flushTabs: (() => void) | null = null
let panelHost: PanelHost | null = null
/**
 * DiagnosticsService is constructed long before ConnectorRegistry exists, and its
 * getter is called from the sidecar's stdout handler — which can fire before the
 * `const connectorRegistry` initializer has run. Closing over the const directly
 * would be a temporal-dead-zone ReferenceError on an unlucky first sample, so
 * route through a mutable ref that starts out empty. Same forward-ref shape the
 * panel write sink uses for AgentService.
 */
let connectorCommandsRef: () => ConnectorCommand[] = () => []

/**
 * Window and panel identities for tier-B diagnostics labels.
 *
 * Runs on the sidecar's stdout 'data' handler, so it must not throw: a wedged
 * or half-torn-down window degrades the labels, never the app. getOSProcessId()
 * throws on a destroyed webContents, which is the one call known to do so.
 *
 * There IS a third BrowserWindow besides main and the editor window:
 * electronPlatform.ts's `floatWin`, the panel float-out host. It's safe to
 * leave unhandled here because `floatWin` never calls `loadURL` — the floated
 * content lives in the reparented PanelView, not floatWin's own webContents —
 * so `floatWin.webContents.getOSProcessId()` returns 0 and the `osPid <= 0`
 * guard below filters it out. That guard is load-bearing for this reason; a
 * fourth window kind that DOES navigate its own webContents would need this
 * revisited.
 */
function collectWindowDescriptorsFromElectron(): WindowDescriptor[] {
  const sources: WindowSource[] = []
  try {
    const mainId = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue
      let osPid: number | null = null
      try {
        osPid = wc.getOSProcessId()
      } catch {
        continue
      }
      sources.push({
        id: wc.id,
        osPid,
        isBrowserWindow: BrowserWindow.fromWebContents(wc) !== null,
        panelTitle: panelHost?.titleForWebContents(wc.id) ?? null,
        isMain: mainId !== null && wc.id === mainId
      })
    }
  } catch (err) {
    console.error('[diagnostics] failed to enumerate webContents', err)
    // Return what was already collected rather than discarding it: windows
    // already resolved keep their names, and whatever wasn't reached yet
    // degrades to a generic "Renderer process" via the label layer's
    // empty-match path instead of vanishing from the page entirely.
  }
  return collectWindowDescriptors(sources)
}
let externalAppHost: ExternalAppHost | null = null
// Module-scope like mainWindow above: registerIpc() constructs this, but createWindow()'s
// 'closed' handler is a separate function scope and needs it too, to unsubscribe a closing
// window so it cannot pin the service to the 1s fast tier forever.
let diagnostics: DiagnosticsService | null = null
// webContents ids that already have diagnostics cleanup listeners wired up (destroyed,
// did-start-navigation, render-process-gone). Prevents piling up listeners per
// subscribe() call from the same sender (StrictMode double-invoke, repeated
// navigation) — at most one listener set is ever attached per id, and every entry
// point removes all three listeners together, so the set and the listeners never
// drift apart.
const diagnosticsDestroyedWired = new Set<number>()

// A shown `Notification` outlives the tick that created it — on Windows the Action Center keeps
// it indefinitely. Its only reference must stay reachable for as long as the OS can still deliver
// a click to it, or V8 is free to collect it (and the click handler with it), silently turning a
// clicked notification into a no-op. Cleared on 'close' too, so a notification the user dismisses
// (or that the OS expires) does not pin memory forever.
const liveNotifications = new Set<Notification>()

// D1 spike instrumentation (exit-check step 7): ARGUS_LOOP_METRICS=1 logs
// main-process event-loop delay percentiles every 30s. Threshold: p99 < 50ms
// with two sessions streaming.
if (process.env.ARGUS_LOOP_METRICS) {
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  setInterval(() => {
    console.log(
      `[loop] p50=${(h.percentile(50) / 1e6).toFixed(1)}ms ` +
        `p99=${(h.percentile(99) / 1e6).toFixed(1)}ms max=${(h.max / 1e6).toFixed(1)}ms`
    )
    h.reset()
  }, 30_000)
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

// argus-panel:// — a Core-owned, standard, sandboxed scheme giving every panel a
// stable 'self' origin for CSP and denying file:// ambient authority. Must be
// registered before app 'ready'.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'argus-panel',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: false
    }
  },
  {
    // argus-case:// — case-file read protocol (3d-1). Registered on a partition only for
    // readCaseFiles-granted windows. corsEnabled so a panel (origin argus-panel://) can
    // cross-origin fetch() and READ the bytes, not just point <img>/media at it (spec §3
    // lists fetch as a consumer). The handler returns Access-Control-Allow-Origin; access
    // stays gated by the per-(pack,case) partition registration + connect-src CSP.
    scheme: 'argus-case',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

function registerIpc(): void {
  const userDataDir = app.getPath('userData')
  const argusHome = resolveArgusHome(userDataDir)
  const db = openDb(dbPath(argusHome))
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath

  diagnostics = (() => {
    const repoRoot = path.resolve(app.getAppPath(), '..')
    const binaryPath = resolveSidecarBinary({ repoRoot, resourcesPath })
    let client: SidecarClientLike
    if (binaryPath) {
      client = new SidecarClient({
        spawner: createElectronSidecarSpawner(),
        binaryPath,
        rootPid: process.pid,
        initialIntervalMs: SLOW_INTERVAL_MS
      })
    } else {
      console.log('[diagnostics] no sidecar binary for this platform; diagnostics unavailable')
      client = createDisabledSidecarClient('no sidecar binary for this platform')
    }
    return new DiagnosticsService({
      client,
      rootPid: process.pid,
      cores: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      getElectronMetrics: () =>
        app.getAppMetrics().map((m) => ({
          pid: m.pid,
          creationTimeMs: m.creationTime,
          type: m.type,
          ...(m.serviceName ? { serviceName: m.serviceName } : {})
        })),
      getWindowDescriptors: collectWindowDescriptorsFromElectron,
      getConnectorCommands: () => connectorCommandsRef(),
      processLabels: defaultProcessLabels,
      // DiagnosticsService is constructed before AgentService and ExternalAppHost, and
      // this getter is called from the sidecar's stdout handler — same forward-ref shape
      // as connectorCommandsRef above, for the same reason (a closed-over const would be
      // a temporal-dead-zone ReferenceError on an unlucky first sample).
      getLiveOwners: () => [
        ...(agentService?.liveOwnerKeys() ?? []),
        ...(externalAppHost?.list().map((a) => a.caseSlug) ?? [])
      ],
      // Same forward-ref shape and reason as getLiveOwners above: this is read from the
      // sidecar's stdout handler, and AgentService is constructed later.
      getBusyOwners: () =>
        (agentService?.states() ?? [])
          .filter((s) => s.activeTurn)
          .map((s) => ownerKeyOf(s.caseSlug, s.sessionId)),
      terminator: new Terminator({
        kill: (pid, signal) => process.kill(pid, signal),
        // NOT process.kill(pid, 0) — that only answers "does SOME process hold this
        // pid", which is exactly what lets a SIGKILL escalation land on an unrelated
        // process the OS recycled the pid to during the 5s grace window. Re-resolve
        // identity against the CURRENT tree snapshot instead: the pid must still be
        // reported, with the SAME startTimeMs. `diagnostics` is a forward ref for the
        // same reason getLiveOwners below is — the Terminator is constructed before the
        // DiagnosticsService whose deps embed it.
        treeStartTimeMs: (pid) =>
          (diagnostics?.latest()?.tree ?? []).find((p) => p.pid === pid)?.startTimeMs ?? null,
        // The fallback for when the tree above can't answer at all — an ancestor also
        // missing from the walk, not just this pid (see terminate.ts Terminator.shouldKill).
        // This is real process.kill(pid, 0), the same "does SOME process hold this pid"
        // check called out above: safe here specifically because it is only ever reached
        // once treeStartTimeMs has already ruled out a live-but-recycled process at pid.
        isAlive: (pid) => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        }
      })
    })
  })()

  diagnostics?.start()
  diagnostics?.onSnapshot((s) => broadcast(IPC.diagnosticsSample, s))

  const seededDir = seededPacksDir(app.getAppPath(), resourcesPath)
  const installedDir = ensurePacksDir(argusHome)
  const packRegistry = PackRegistry.load([seededDir, installedDir])

  // Resolve an argus-panel:// URL to its on-disk asset + the window's per-panel CSP.
  // The pack partition's protocol handler (registered in the factory) calls this — the
  // handler must live on the panel's partition session, not the default session.
  const servePanel = (url: string): { filePath: string; csp: string } | null => {
    // webPanel-only: externalApp windows have uiDir === null and are routed
    // elsewhere (Task 6); including them here would let a crafted
    // argus-panel://<extpack>/<extwin>/... request reach path.join(null, …).
    const decls = packRegistry.windowDecls().filter((w) => w.decl.kind === 'webPanel')
    const locs: PanelWindowLoc[] = decls.map((w) => ({
      packId: w.packId,
      windowId: w.decl.id,
      uiDir: w.uiDir as string,
      entry: w.decl.entry
    }))
    const filePath = resolvePanelAsset(locs, url)
    if (!filePath) return null
    const owner = decls.find((w) => url.startsWith(`argus-panel://${w.packId}/${w.decl.id}/`))
    return {
      filePath,
      csp: buildPanelCsp(owner ? owner.decl.network : [], {
        allowCaseFiles: owner?.decl.permissions.includes('readCaseFiles') ?? false
      })
    }
  }

  const panelWriteSink: import('./services/panels/bridge').PanelWriteSink = {
    sendToAgent: (caseSlug, sessionId, text) =>
      broadcast(IPC.panelsDraft, { caseSlug, sessionId, text }),
    emitFinding: (caseSlug, sessionId, input) =>
      agentService!.emitPanelFinding(caseSlug, sessionId, input),
    cite: (target, relPath, line) => broadcast(IPC.panelsCiteAdded, { ...target, relPath, line }),
    ingestEvidence: async (caseSlug, sessionId, input) => {
      caseWatch.suppress(caseSlug) // pre-write: the ingest lands inside the watched evidence dir
      const res = await agentService!.ingestPanelEvidence(caseSlug, sessionId, input)
      if (res.ok) broadcast(IPC.panelsEvidenceIngested, { caseSlug, evidenceId: res.evidenceId })
      return res
    },
    sendImageToAgent: async (caseSlug, sessionId, input) => {
      caseWatch.suppress(caseSlug) // pre-write: the ingest lands inside the watched evidence dir
      // Reuse the approval-gated PNG→screenshot ingest, then stage a composer draft that
      // points the agent at the saved file (the proven capture_panel evidence+Read route).
      const res = await agentService!.ingestPanelEvidence(caseSlug, sessionId, {
        source: { bytes: input.bytes },
        filename: input.filename
      })
      if (!res.ok) return res
      broadcast(IPC.panelsEvidenceIngested, { caseSlug, evidenceId: res.evidenceId })
      const caption = input.caption?.trim()
      const text =
        (caption ? `${caption}\n\n` : '') +
        fillPrompt(resolvePrompt('synthesized.panel-capture'), { relPath: res.relPath })
      broadcast(IPC.panelsDraft, { caseSlug, sessionId, text })
      return { ok: true, evidenceId: res.evidenceId }
    }
  }

  panelHost = new PanelHost({
    db,
    argusHome,
    factory: createElectronPanelFactory(() => mainWindow, servePanel, argusHome),
    onChange: () => broadcast(IPC.panelsChanged, undefined),
    writeSink: panelWriteSink
  })

  externalAppHost = new ExternalAppHost({
    spawner: createElectronProcessSpawner(),
    logDir: path.join(argusHome, 'logs', 'external-app'),
    onChange: () => broadcast(IPC.panelsChanged, undefined),
    processLabels: defaultProcessLabels
  })

  const packsState = new PacksStateStore(argusHome)
  /**
   * Pack ids written to disk since `packRegistry` was loaded, a few lines above. Every write path
   * (install, install-from-repo, uninstall, applied update) records here, and `listInstalledPacks`
   * turns it into the relaunch prompt. Process-scoped on purpose: a relaunch is exactly what makes
   * it empty again, so there is nothing to persist and nothing to clear.
   */
  const packsTouched = new Set<string>()
  const coreSkillsDir = resolveCoreSkillsDir(app.getAppPath(), resourcesPath)
  const skillSources = [
    ...packRegistry.skillsSources(),
    // Core-shipped skills seed AFTER packs: later-wins means a pack cannot
    // silently replace a core capability. The dev env override stays last.
    coreSkillsDir,
    ...(process.env.ARGUS_SKILLS_DIR ? [process.env.ARGUS_SKILLS_DIR] : [])
  ]
  // Later-wins is deliberate, but the loser disappears before resolveSkills can see it, so
  // two packs claiming one name would otherwise be indistinguishable from one never
  // shipping it. Report before seeding flattens the sources.
  for (const c of detectSkillCollisions(skillSources)) {
    console.warn(
      `[skills] name collision on "${c.name}": ${c.winner} wins; shadowed: ${c.shadowed.join(', ')}`
    )
  }
  seedSharedAssets(argusHome, {
    skills: skillSources,
    references: [
      ...packRegistry.referencesSources(),
      ...(process.env.ARGUS_REFERENCES_DIR ? [process.env.ARGUS_REFERENCES_DIR] : [])
    ]
  })

  // settingsService and binariesService are mutually dependent (settingsService.payload()
  // embeds binariesService.settingsRows(); binariesService reads settingsService.get().tools).
  // Break the cycle with a `let` closed over by the settings callback — it only runs at
  // payload() time, by which point binariesService has been assigned below.
  // eslint-disable-next-line prefer-const -- forward declaration; assigned once below, read only via closure
  let binariesService: BinariesService
  // Single evaluation of the prompt-surface dev gate; `is` is already imported at the top of
  // this file. Everything downstream reads this boolean, never the env directly.
  const devTools = devToolsEnabled({ isDev: is.dev, unlocked: readDevToolsUnlocked(argusHome) })
  const promptStore = new PromptStore({ devTools, argusHome })
  const resolvePrompt = promptStore.resolveFn()
  const promptCaptures = new PromptCaptureStore({ devTools, argusHome })

  // GUARD 2. A terminal-only session — run the app, reproduce something, read stdout — never
  // opens Settings, so the banner cannot reach it. This is the only guard that does. The message
  // text itself lives in bootWarnings.ts, which is unit-tested — this file cannot be, since
  // nothing here calls `registerIpc()` in a test.
  for (const w of overrideBootWarnings({
    ids: promptStore.activeOverrideIds(),
    loadError: promptStore.loadError
  }))
    console.warn(w)

  const settingsService = new SettingsService(argusHome, {
    resolvedTools: () => binariesService.settingsRows(),
    devTools
  })
  appSettings = settingsService

  // Usage-stats epoch: stamped once; anchors the memory-hygiene grace period (spec §2).
  ensureTrackingStarted(settingsService)

  // One-time upgrade: a `bypassPermissions` default set back when it was inert must not
  // silently go live now that it is paired with allowDangerouslySkipPermissions.
  migrateBypassDefault(settingsService)

  // One-time upgrade: fold the legacy single `general.defaultRepo` into the new
  // `general.defaultRepos` list.
  migrateDefaultRepoToList(settingsService)

  // Capture declared user env BEFORE anything mutates process.env, then let the
  // service export resolved values / prepend pathDirs for spawned children.
  const capturedBinaryEnv = Object.fromEntries(
    packRegistry
      .binaryDecls()
      .filter(({ decl }) => decl.envVar)
      .map(({ decl }) => [decl.envVar as string, process.env[decl.envVar as string]])
  )
  binariesService = new BinariesService({
    registry: packRegistry,
    settingsTools: () => settingsService.get().tools,
    capturedEnv: capturedBinaryEnv
  })

  const codeGraph = new CodeGraphService({
    argusHome,
    pathOf: (id) => binariesService.pathOf(id),
    recompute: () => binariesService.recompute(),
    broadcast,
    processLabels: defaultProcessLabels
  })

  // 1d: pack-driven detection engine replaces the hardcoded detect.ts.
  const detection = createDetection(packRegistry)
  // 1d: extraction commands are resolved from pack detector declarations, not hardcoded ids.
  const extractors = createExtractors(packRegistry, binariesService)

  // — case-dir watcher hub (files explorer staleness hint) —
  const caseWatch = createCaseWatchHub(argusHome, (slug) => broadcast(IPC.filesChanged, slug))
  // every main-side evidence mutation announces itself here; the paired suppress()
  // keeps the watcher's staleness hint from re-lighting on our own writes
  const evidenceChangedB = (slug: string): void => {
    caseWatch.suppress(slug)
    broadcast(IPC.evidenceChanged, slug)
  }

  // The one ingest queue. Every path that registers evidence enqueues here, and this is
  // the only place FTS indexing and pack extraction run — off the ingest call's critical
  // path, one job at a time, with progress published to the renderer.
  //
  // Constructed before jiraService, onboardingService and the evidence IPC handlers,
  // because they all take it as a dependency.
  const ingestQueue: IngestQueue = new IngestQueue({
    db,
    argusHome,
    // Re-reads the row by id rather than closing over a record: by the time the queue
    // reaches this job the row may have been rewritten (or deleted) since it was enqueued.
    extract: async (evidenceId) => {
      const rec = getEvidenceRecord(db, evidenceId)
      if (!rec) return false
      // A derived row is extraction's OUTPUT, so it is never its input. Skipping it is
      // not just an optimisation: ingestDerived enqueues the row it writes, so a pack
      // declaring an extract command for the derived type would otherwise recurse
      // forever, each run producing one more derived file.
      if (rec.meta.derivedFrom !== undefined) return false
      const derived = await extractDerivedText(db, argusHome, ingestQueue, rec, extractors)
      return derived !== null
    },
    onItemProgress: (p) => broadcast(IPC.evidenceProgress, p),
    onQueueProgress: (p) => broadcast(IPC.evidenceQueueProgress, p),
    onEvidenceChanged: (slug) => evidenceChangedB(slug)
  })
  // A crash mid-index leaves rows stuck at 'pending'/'indexing' and silently unsearchable.
  const requeued = requeuePendingIndexes(db, argusHome, ingestQueue)
  if (requeued > 0) console.log(`[ingest] re-queued ${requeued} unfinished index(es) after restart`)

  const secretStore = new SecretStore(argusHome, safeStorage)

  const defectCorpus = new DefectCorpusService({
    sources: () => settingsService.get().defectCorpus.sources,
    token: (id) => secretStore.resolve(corpusTokenSecret(id)) ?? undefined
  })

  // — observability: Langfuse exporter (off by default; needs enabled+host+publicKey+secret) —
  const buildExporter = (): void => {
    const s = settingsService.get().observability?.langfuse
    if (!s?.enabled || !s.host || !s.publicKey) {
      langfuseExporter = null
      return
    }
    const secretKey = secretStore.resolve('observability/langfuse/secret-key')
    if (!secretKey) {
      langfuseExporter = null
      return
    }
    langfuseExporter = new LangfuseExporter(
      new LangfuseSink(createLangfuseTracing({ host: s.host, publicKey: s.publicKey, secretKey })),
      { captureContent: s.captureContent }
    )
  }
  buildExporter()

  const connectorRegistry = new ConnectorRegistry(argusHome)
  // Late-bound: diagnostics was constructed above, before this registry existed.
  connectorCommandsRef = () => stdioConnectorCommands(connectorRegistry.get())
  const toolRiskStore = new ToolRiskStore(argusHome)
  const agentAccessStore = new AgentAccessStore(argusHome)
  const refSyncStore = new ReferenceSyncStore(argusHome)
  const connectorPresets = loadPresets(argusHome)

  // — editor window (asset editor in its own BrowserWindow) —
  // Constructed here (not in createWindow()) because argusHome is scoped to this function;
  // an app-lifetime singleton like panelHost/externalAppHost above, not paired 1:1 with
  // mainWindow's create/destroy cycle. See mainWindow.on('closed', ...) in createWindow().
  const editorWindowStore = new EditorWindowStore(argusHome)
  // Main owns the debounce, exactly as it does for `editor:draft-changed` (spec §4.2): the
  // renderer sends on every cursor move and never waits on a write. 1s rather than the draft
  // store's ~500ms — losing a cursor position is a smaller harm than losing text.
  //
  // Declared HERE, above the service, rather than beside its `EDITOR_IPC.tabsChanged` handler
  // further down: `EditorWindowService.open` has to settle this before it reads the set back, so
  // the service takes it as a dependency and it must exist by the time the service is built.
  let tabsTimer: NodeJS.Timeout | null = null
  let pendingTabs: PersistedTabs | null = null
  const flushPendingTabs = (): void => {
    if (tabsTimer) {
      clearTimeout(tabsTimer)
      tabsTimer = null
    }
    if (pendingTabs) {
      editorWindowStore.saveTabs(pendingTabs)
      pendingTabs = null
    }
  }
  // Published to the module-scope handle the main-window `closed` and `before-quit` paths use.
  flushTabs = flushPendingTabs
  editorWindowService = new EditorWindowService({
    createWindow: makeElectronEditorWindowFactory(
      join(__dirname, '../preload/index.js'),
      (w) => {
        if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
          w.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/editor.html`)
        } else {
          w.loadFile(join(__dirname, '../renderer/editor.html'))
        }
      },
      () => lastTheme,
      () => lastScale
    ),
    loadBounds: () => editorWindowStore.load(),
    saveBounds: (b) => editorWindowStore.save(b),
    loadTabs: () => editorWindowStore.loadTabs(),
    flushTabs: flushPendingTabs
  })
  draftStore = new DraftStore({ argusHome })
  draftStore.onSaved((rec) => {
    // Persist-before-adopt: this fires after the rename, and it is the only thing that makes
    // the editor show "Draft". Sent to the editor window only — no other window cares.
    editorWindowService?.handle()?.send(EDITOR_IPC.draftSaved, {
      kind: rec.kind,
      name: rec.name,
      updatedAt: rec.updatedAt
    })
  })
  const mcpOauth = new McpOAuth(secretStore, (url) => shell.openExternal(url))
  const mcpService = new McpService({
    registry: connectorRegistry,
    secrets: secretStore,
    toolRisk: () => toolRiskStore.get(),
    oauth: mcpOauth,
    processLabels: defaultProcessLabels
  })

  // — Atlassian REST (UI-native; the agent uses Rovo MCP) —
  const atlassianCreds = (): AtlassianAuth =>
    resolveAtlassianCreds(connectorRegistry.get(), mcpOauth)
  const atlassian = new AtlassianClient(atlassianCreds)
  const restErrors: Record<string, string> = {} // instanceId → last auth-error message

  // — reference sync (Wave 3 Part 3; UI-native REST + headless distillation) —
  // — headless one-shot runner shared by case distillation and reference sync —
  // Resolves its own provider from settings.distillProvider; deliberately NOT the active
  // chat instance (see the 2026-07-19 "model (auto)" failure).
  const headlessRun = createHeadlessRunner({
    settings: () => settingsService.get(),
    argusHome,
    // Batch distillation/refSync prompts inline the full current skill/reference bodies and
    // ask the model to return complete files — far heavier than an interactive turn — so the
    // 180s driver default is too tight. Give background jobs a 10-minute budget.
    timeoutMs: 600_000
  })
  const refSync = new RefSyncService({
    argusHome,
    store: refSyncStore,
    reader: atlassian,
    run: headlessRun,
    resolvePrompt
  })
  /**
   * The one "references changed" signal.
   *
   * Regenerating INDEX.md is tied to the broadcast because the broadcast is the thing no writer
   * can forget — skip it and the Library list goes stale in front of the user. Regeneration used
   * to live in two of the seven writers, so a reference authored in the editor stayed absent from
   * the agent-facing router indefinitely. regenerateIndex is content-guarded, so calling it on a
   * path that changed nothing writes nothing.
   */
  const referencesChanged = (): void => {
    refSync.regenerateIndex()
    broadcast(IPC.refsyncChanged, refSync.payload())
  }
  refSyncStore.subscribe(() => referencesChanged())
  // Heal the router once at boot, after seedSharedAssets has laid down pack references.
  // Existing installs carry an INDEX.md last written by whenever their final Confluence sync
  // apply ran — on this machine, five days and one hand-authored reference out of date — and
  // without this it stays wrong until something happens to mutate a reference. No broadcast:
  // no window exists yet, and regenerateIndex writes nothing when the content already matches.
  refSync.regenerateIndex()

  // — case-close distillation (part 3a): mirrors the resolveSkills(...) call used by
  // skillsPayload() below, filtered to enabled and mapped to the {name, description, content}
  // shape the distiller's prompt expects. `content` is the tier-winning SKILL.md verbatim —
  // the same file currentContent() diffs a skill-edit against — so the distiller can return
  // the whole file with its change merged in (a skill-edit's content is the complete file).
  const skillsIndexForDistill = (): { name: string; description: string; content: string }[] =>
    resolveSkills(argusHome, agentAccessStore.get())
      .filter((s) => s.enabled)
      .map((s) => {
        let content = ''
        try {
          content = fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8')
        } catch {
          /* a skill dir with no readable SKILL.md can't be edited; leave content empty */
        }
        return { name: s.name, description: s.description, content }
      })
  const editorCorpus = new EditorCorpusService({
    argusHome,
    listSkills: () =>
      resolveSkills(argusHome, agentAccessStore.get()).map((s) => ({
        name: s.name,
        dir: s.dir,
        description: s.description,
        tier: s.tier
      }))
  })
  const distillQueue = new DistillQueue({
    db,
    assembleInput: (slug) => assembleDistillInput(db, argusHome, slug, skillsIndexForDistill()),
    distill: (input, signal) => runCaseDistill(input, headlessRun, resolvePrompt, signal),
    stage: (slug, jobId, output) => stageDistillOutput(db, argusHome, slug, jobId, output),
    broadcast: (p) => broadcast(IPC.distillChanged, p),
    promptHash: () => caseDistillPromptHash(resolvePrompt)
  })
  distillQueue.recoverOnBoot()
  const onCaseClosed = (rec: CaseRecord): void => {
    try {
      // Reconcile first: an in-flight job for this case (started while it was open) must be
      // cancelled before the close-time snapshot is enqueued, or both jobs run and the newest
      // one shadows the older, still-running one from every renderer read — see
      // reconcileAndEnqueue's doc comment in queue.ts.
      reconcileAndEnqueue(distillQueue, rec.slug)
    } catch (err) {
      console.error('[distill] enqueue failed', err)
    }
  }

  // — case RCA reports (part 3a-N): same headless runner as distillation, own job table —
  const rcaJobs = new RcaJobs({
    db,
    argusHome,
    assembleInput: (slug, prior) => assembleRcaInput(db, argusHome, slug, prior),
    run: headlessRun,
    resolvePrompt,
    broadcast: (p) => broadcast(IPC.rcaChanged, p),
    promptHash: () => caseRcaPromptHash(resolvePrompt, settingsService.get().rca.template),
    settings: () => settingsService.get()
  })
  rcaJobs.recoverOnBoot()

  const connectorsPayload = (): ConnectorsPayload => ({
    connectors: connectorRegistry.get(),
    runtime: mcpService.runtimeStates(),
    oauth: Object.fromEntries(
      Object.keys(connectorRegistry.get()).map((id) => [id, mcpOauth.status(id)])
    ),
    rest: { ...restErrors },
    loadError: connectorRegistry.loadError(),
    secretsAvailable: secretStore.available(),
    secretsLoadError: secretStore.loadError(),
    presets: connectorPresets
  })

  connectorRegistry.subscribe(() => broadcast(IPC.connectorsChanged, connectorsPayload()))

  const memoryTopicsPayload = (): MemoryTopicsPayload => {
    const access = agentAccessStore.get()
    const indexLines = readIndex(argusHome)
      .split('\n')
      .filter((l) => l.trim()).length
    return {
      topics: listTopics(argusHome).map((t) => ({ ...t, enabled: topicEnabled(access, t.name) })),
      indexLines,
      capLines: MEMORY_INDEX_MAX_LINES,
      capBytes: MEMORY_TOPIC_MAX_BYTES
    }
  }

  agentAccessStore.subscribe(() => broadcast(IPC.accessChanged, agentAccessStore.payload()))

  // shared with the agent:auth-status handler below (see AuthCache's docblock for the
  // invalidation contract)
  const authCache = new AuthCache(
    async () => {
      const settings = settingsService.get()
      const { driver, unknownSlug } = resolveDriver(settings.agent)
      // Unknown driver slug (e.g. a provider instance naming a not-yet-registered driver
      // kind): report the mismatch directly instead of silently probing the Claude
      // fallback, which would misreport an unrelated account as this instance's status.
      if (unknownSlug) {
        return { ok: false, verified: false, detail: `Unknown agent driver: ${unknownSlug}` }
      }
      const result = await driver.probeAuth({
        timeoutMs: settings.agent.probeTimeoutMs,
        cliPath: activeInstanceConfig(settings).cliPath
      })
      // A probe alone never proves credentials work (see driver.ts's ProbeAuthResult
      // docblock) — verified is always false here; AuthCache promotes it once a real
      // turn succeeds. `fixHint` rides along so every consumer (settings card, onboarding
      // step, health row) renders the ACTIVE driver's remediation rather than Claude's.
      return { ...result, verified: false, fixHint: driver.authFixHint }
    },
    () => broadcast(IPC.agentAuthChanged, undefined)
  )

  // Fired whenever the provider-status list changes, so the settings page re-reads without
  // waiting for its own poll. Shared between ProviderStatusService (after a probe lands) and
  // modeRefusals (after a NEW refusal is recorded) — same channel, same payload, so there's
  // no second notion of "providers changed" to keep in sync.
  const notifyProvidersChanged = (): void => broadcast(IPC.providersChanged, undefined)

  // Per-instance record of permission modes the CLI has refused to adopt this app session
  // (e.g. an org policy blocking bypassPermissions, so the CLI silently falls back to
  // `default`). In-memory only, never persisted — a policy can change between launches, and
  // a stale disable surviving a restart is worse than one that clears and gets re-observed.
  // Recorded from the interactive agent event sink below; read here so the settings page can
  // show it per instance. Only cleared by the user-initiated IPC.providerRefresh handler
  // below — never by a periodic or settings-triggered refreshAll(), which would make a still-
  // true refusal evaporate on a timer.
  const modeRefusals = new ModeRefusalRegistry({ notify: notifyProvidersChanged })

  // Per-instance provider status for the settings page (every enabled provider at once),
  // as opposed to authCache's single default-provider verdict.
  const latestNpmVersion = createNpmVersionLookup()
  providerStatusService = new ProviderStatusService({
    settings: () => settingsService.get().agent,
    driverFor: (instanceId) =>
      resolveInstanceDriver(settingsService.get().agent, instanceId).driver,
    notify: notifyProvidersChanged,
    latestVersion: async (driverKind) => {
      const pkg = getDriverByKind(driverKind).npmPackage
      return pkg ? latestNpmVersion(pkg) : null
    },
    modeRefusals
  })
  providerStatusService.start()

  settingsService.subscribe(() => {
    binariesService.recompute()
    authCache.invalidate()
    // Editing a provider's config (CLI path, credentials) invalidates its probe too.
    providerStatusService?.onSettingsChanged()
    const old = langfuseExporter
    void old?.shutdown()
    buildExporter()
    broadcast(IPC.settingsChanged, settingsService.payload())
  })

  // — wave 0 handlers unchanged —
  ipcMain.handle(IPC.casesCreate, async (_e, input: NewCaseInput) => {
    const rec = createCase(db, argusHome, input, resolvePrompt)
    await autoLinkDefaultRepo(db, argusHome, rec.slug, settingsService.get().general.defaultRepos)
    return rec
  })
  const sampleAssetsDir = resolveSampleAssetsDir(app.getAppPath(), resourcesPath)
  const onboardingService = new OnboardingService({
    db,
    argusHome,
    detection,
    queue: ingestQueue,
    sampleAssetsDir,
    listCaseSlugs: () => listCases(db).map((c) => c.slug),
    resolvePrompt
  })
  ipcMain.handle(IPC.onboardingSeedSample, () => onboardingService.seedSampleCase())
  ipcMain.handle(IPC.casesList, () => listCases(db))
  ipcMain.handle(
    IPC.casesSetStatus,
    (_e, slug: string, status: CaseStatus, resolution: CaseResolution | null, distill = true) =>
      setCaseStatus(db, argusHome, slug, status, resolution, distill ? onCaseClosed : undefined)
  )
  ipcMain.handle(IPC.evidenceIngest, async (_e, caseSlug: string, absPaths: string[]) => {
    caseWatch.suppress(caseSlug) // pre-write: our own copies must not light the staleness dot
    // A drop carries only a case slug, not a session — file it into the case's own mode.
    const kase = getCase(db, caseSlug)
    if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
    // Sequential, not Promise.all: collisionFreeName probes the destination directory, so two
    // concurrent copies of same-named files could pick the same free name.
    const records: EvidenceRecord[] = []
    // The suppression window is 1500ms and the watcher debounce 300ms. While the copy
    // was synchronous the blocked event loop could not deliver a watcher event at all,
    // so one window plus a trailing re-arm covered the whole drop. copyAndHash yields,
    // so the window can now expire mid-drop and the debounce fire on the user's own
    // writes. Re-arm per file AND on a timer, because the file this project exists for
    // is a single multi-GB one whose copy alone outlives any fixed window.
    const rearm = setInterval(() => caseWatch.suppress(caseSlug), 1000)
    try {
      for (const p of absPaths) {
        caseWatch.suppress(caseSlug)
        records.push(
          await ingestArtifact(
            db,
            argusHome,
            detection,
            ingestQueue,
            caseSlug,
            p,
            'upload',
            {},
            kase.activeMode
          )
        )
      }
    } finally {
      clearInterval(rearm)
      // final re-arm: the last file's sidecar writes land after its copy returns
      caseWatch.suppress(caseSlug)
    }
    // indexing + derived text are the queue's job now; progress reaches the renderer via the
    // ingest queue's own onItemProgress/onQueueProgress broadcasts (IPC.evidenceProgress /
    // IPC.evidenceQueueProgress), not through this handler
    return records
  })
  ipcMain.handle(
    IPC.evidenceIngestContent,
    (_e, caseSlug: string, fileName: string, bytes: Uint8Array) => {
      assertSlug(caseSlug)
      caseWatch.suppress(caseSlug) // our own write must not light the staleness dot
      // A paste carries only a case slug, not a session — file it into the case's own mode.
      const kase = getCase(db, caseSlug)
      if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
      const { record, deduped } = ingestBytes(
        db,
        argusHome,
        detection,
        ingestQueue,
        caseSlug,
        path.basename(fileName), // defence in depth: no traversal out of the mode's directory
        Buffer.from(bytes),
        'paste',
        {},
        kase.activeMode
      )
      // indexing + derived text are the queue's job now (a dedupe hit enqueues nothing)
      // no re-arm suppress() here: evidenceChangedB() below already suppresses
      // internally, and suppress() is monotonic — a second call here is a no-op
      evidenceChangedB(caseSlug)
      return { record, deduped }
    }
  )
  ipcMain.handle(IPC.evidenceList, (_e, caseSlug: string, scope?: EvidenceScope) => {
    if (scope !== undefined && scope !== 'investigation' && scope !== 'review' && scope !== 'all')
      throw new Error(`Invalid evidence scope: ${JSON.stringify(scope)}`)
    // start the staleness watcher on first listing; unknown slugs stay unwatched
    if (getCase(db, caseSlug)) caseWatch.watch(caseSlug)
    return listEvidence(db, caseSlug, scope)
  })
  ipcMain.handle(IPC.evidenceRead, (_e, evidenceId: number, focusLine?: number) =>
    readEvidenceText(db, argusHome, evidenceId, focusLine)
  )
  ipcMain.handle(
    IPC.evidenceReadSnippet,
    (_e, caseSlug: string, relPath: string, line: number, end?: number) => {
      assertSlug(caseSlug)
      return readEvidenceSnippet(db, argusHome, caseSlug, relPath, line, end ?? line)
    }
  )
  const textdocHub = new TextDocSearchHub(
    db,
    argusHome,
    (payload) => broadcast(IPC.textdocSearchHits, payload),
    (p) => broadcast(IPC.textdocIndexProgress, p)
  )
  ipcMain.handle(IPC.textdocOpen, (_e, source: TextDocSource) =>
    openTextDoc(db, argusHome, source, (key, fraction) =>
      broadcast(IPC.textdocIndexProgress, { key, fraction })
    )
  )
  ipcMain.handle(IPC.textdocLines, (_e, source: TextDocSource, from: number, to: number) =>
    readTextDocLines(db, argusHome, source, from, to)
  )
  ipcMain.handle(
    IPC.textdocSearch,
    (_e, searchId: string, source: TextDocSource, query: string, opts: TextDocSearchOpts) =>
      void textdocHub.start(searchId, source, query, opts)
  )
  ipcMain.handle(IPC.textdocCancelSearch, (_e, searchId: string) => textdocHub.cancel(searchId))
  ipcMain.handle(IPC.evidenceDelete, (_e, caseSlug: string, evidenceId: number) => {
    assertSlug(caseSlug)
    if (!Number.isInteger(evidenceId)) throw new Error(`Invalid evidence id: ${evidenceId}`)
    const r = deleteEvidence(db, argusHome, ingestQueue, caseSlug, evidenceId)
    evidenceChangedB(caseSlug)
    return r
  })
  ipcMain.handle(IPC.evidenceScan, (_e, caseSlug: string, mode?: ModeId) => {
    assertSlug(caseSlug)
    if (mode !== undefined && mode !== 'investigation' && mode !== 'review')
      throw new Error(`Invalid mode: ${JSON.stringify(mode)}`)
    caseWatch.suppress(caseSlug, 5000) // hashing a large folder outlives the default window
    return scanEvidence(
      db,
      argusHome,
      detection,
      { evidenceChanged: evidenceChangedB, queue: ingestQueue },
      caseSlug,
      mode
    )
  })
  ipcMain.handle(IPC.searchQuery, (_e, q: string, filters?: SearchFilters): UnifiedSearchResult => {
    const f = filters ?? {}
    const sources = f.sources ?? ['evidence']
    const hits: UnifiedHit[] = []
    // pendingIndexCount only ever comes from the evidence backend — chat/summary search
    // have no background index — so it stays 0 when 'evidence' wasn't asked for.
    let pendingIndexCount = 0
    if (sources.includes('evidence')) {
      const evidence = searchEvidenceWithStatus(db, q, f)
      hits.push(...evidence.hits.map((h) => ({ kind: 'evidence' as const, ...h })))
      pendingIndexCount = evidence.pendingIndexCount
    }
    if (sources.includes('chat')) hits.push(...searchAllMessages(db, q, f.caseSlug))
    if (sources.includes('summaries'))
      hits.push(
        ...searchCaseSummaries(db, q, { limit: 5 }).map((h) => ({ kind: 'summary' as const, ...h }))
      )
    return { hits, pendingIndexCount }
  })
  ipcMain.handle(IPC.chatSearch, (_e, caseSlug: string, q: string) =>
    searchMessages(db, caseSlug, q)
  )
  // 1d: renderer artifact type/analyze-skill metadata sourced from pack detectors + generics.
  ipcMain.handle(IPC.packsArtifactMeta, () => detection.artifactMeta())
  // 1e: reference-sync routing seeds sourced from pack manifests.
  ipcMain.handle(IPC.packsReferenceRouting, () => packRegistry.referenceRouting())

  // — packs (install/uninstall/list; 2c) —
  // Checked only when the Packs page asks, never on boot: a fan-out to every vendor origin at
  // startup is exactly the traffic a locked-down environment notices.
  const packUpdates = new PackUpdatesService({
    argusHome,
    state: packsState,
    http: nodeHttpClient,
    gh: nodeGhClient
  })
  let packUpdateStatuses: Record<string, UpdateStatus> = {}
  ipcMain.handle(IPC.packsList, () =>
    listInstalledPacks({
      state: packsState,
      registry: packRegistry,
      binaries: binariesService,
      updates: packUpdateStatuses,
      touched: packsTouched
    })
  )
  ipcMain.handle(IPC.packsPickBundle, async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Argus pack bundle', extensions: ['zip'] }]
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle(IPC.packsInspect, (_e, source: string) =>
    inspectBundleSource(source, { installed: packsState.list() })
  )
  // `packsPlanBundle`/`packsApplyPlan` are registered by `registerPacksPlanIpc` rather than inline:
  // `handle` is injected there so the apply handler's capture-and-clear race fix (see planIpc.ts)
  // is directly testable without importing `electron`.
  registerPacksPlanIpc((channel, fn) => ipcMain.handle(channel, (e, ...args) => fn(e, ...args)), {
    resolver: makeCandidateResolver({ http: nodeHttpClient, gh: nodeGhClient }),
    download: (candidate, destPath) =>
      downloadCandidate(candidate, destPath, nodeGhClient, nodeHttpClient),
    packsState,
    argusHome,
    tempRoot: app.getPath('temp'),
    onApplied: (res) => {
      for (const p of res.installed) packsTouched.add(p.id)
      if (res.installed.length > 0) {
        broadcast(IPC.packsChanged, undefined)
        referencesChanged()
      }
    }
  })
  ipcMain.handle(
    IPC.packsInspectRepo,
    async (
      _e,
      ref: string
    ): Promise<{ ok: true; packs: RepoPackRow[] } | { ok: false; error: string }> => {
      const parsed = parseGhRef(ref)
      if (!parsed) return { ok: false, error: 'Enter a repository as owner/repo.' }
      try {
        return { ok: true, packs: await listRepoPacks({ gh: nodeGhClient }, parsed) }
      } catch (err) {
        // GhError already carries a user-facing sentence (missing gh, signed out, 404). A
        // ZodError's #message is a multi-line JSON blob — fine for a log, not a settings alert —
        // so pull out the first issue's message the same way packUpdates.ts's findFeedUpdate does.
        const message =
          err instanceof ZodError
            ? (err.issues[0]?.message ?? 'repository response did not match the expected shape')
            : (err as Error).message
        return { ok: false, error: message }
      }
    }
  )
  ipcMain.handle(
    IPC.packsInstallFromRepo,
    async (_e, ref: string, packId: string): Promise<InstallResult> => {
      const parsed = parseGhRef(ref)
      if (!parsed)
        return { ok: false, code: 'manifest', error: 'Enter a repository as owner/repo.' }
      const res = await installFromRepo(
        { gh: nodeGhClient, argusHome, state: packsState },
        parsed,
        packId
      )
      if (res.ok) {
        packsTouched.add(res.id)
        broadcast(IPC.packsChanged, undefined)
        // A pack seeds (and on uninstall reaps) reference files, so its install is a reference
        // mutation too — packsChanged alone left the Library list and INDEX.md behind.
        referencesChanged()
      }
      return res
    }
  )
  ipcMain.handle(IPC.packsInstall, async (_e, source: string) => {
    const res = await installPack(source, { argusHome, state: packsState })
    if (res.ok) {
      packsTouched.add(res.id)
      broadcast(IPC.packsChanged, undefined)
      referencesChanged()
    }
    return res
  })
  ipcMain.handle(IPC.packsUninstall, (_e, id: string) => {
    const res = uninstallPack(id, { argusHome, state: packsState, coreSkillsDir })
    if (res.ok) {
      packsTouched.add(id)
      broadcast(IPC.packsChanged, undefined)
      referencesChanged()
    }
    return res
  })
  ipcMain.handle(IPC.packsRelaunch, () => {
    app.relaunch()
    app.quit()
  })
  ipcMain.handle(IPC.packsCheckUpdates, async () => {
    packUpdateStatuses = await packUpdates.checkAll()
    broadcast(IPC.packsChanged, undefined)
    return packUpdateStatuses
  })
  ipcMain.handle(IPC.packsApplyUpdate, async (_e, id: string) => {
    const status = await packUpdates.apply(id)
    // 'ready' is the only phase that got as far as installPack — see packUpdates.apply.
    if (status.phase === 'ready') packsTouched.add(id)
    packUpdateStatuses = { ...packUpdateStatuses, [id]: status }
    broadcast(IPC.packsChanged, undefined)
    return status
  })

  // — app auto-update (notify first; spec §3) —
  // The backend is only constructed when packaged: electron-updater reads app metadata that
  // does not exist in an unpackaged build, and the service reports `unsupported` there anyway.
  const coreUpdater = new CoreUpdaterService({
    backend: app.isPackaged ? createElectronUpdaterBackend(autoUpdater) : noopBackend,
    currentVersion: app.getVersion(),
    supported: app.isPackaged
  })
  // Disposer intentionally discarded: this registration lives for the process lifetime and
  // there is nothing that ever tears it down.
  registerUpdateIpc({
    handle: (channel, fn) => ipcMain.handle(channel, () => fn()),
    broadcast,
    service: coreUpdater
  })
  // Deferred past window creation so it does not contend with startup, and silent on failure —
  // an offline user must not meet a failure banner on every launch.
  setTimeout(() => void coreUpdater.check({ manual: false }), 5_000).unref()

  // — panels (webPanel host; 3a-2) —
  const panelWindow = (
    packId: string,
    windowId: string
  ): ReturnType<typeof packRegistry.windowDecls>[number] | null =>
    packRegistry.windowDecls().find((w) => w.packId === packId && w.decl.id === windowId) ?? null

  // Shared by the panelsOpen IPC handler and the agent's open_panel native tool (3b-2).
  const openPanelFor = (
    caseSlug: string,
    sessionId: number,
    packId: string,
    windowId: string,
    evidenceId?: number
  ): { ok: boolean; reason?: string; panel?: unknown } => {
    const w = panelWindow(packId, windowId)
    if (!w) return { ok: false, reason: `unknown panel: ${packId}/${windowId}` }
    if (w.decl.kind === 'externalApp') {
      const info = externalAppHost!.open({
        caseSlug,
        packId,
        windowId,
        title: w.decl.title,
        entry: path.join(w.packDir, ...w.decl.entry.split('/')),
        cwd: w.packDir,
        runtime: w.decl.runtime
      })
      broadcast(IPC.panelsChanged, undefined)
      return { ok: true, panel: info }
    }
    const info = panelHost!.open({
      caseSlug,
      packId,
      windowId,
      title: w.decl.title,
      entry: w.decl.entry,
      uiDir: w.uiDir as string,
      network: w.decl.network,
      permissions: w.decl.permissions as PanelPermission[],
      focus: evidenceId != null ? { evidenceId } : undefined,
      sessionId
    })
    broadcast(IPC.panelsChanged, undefined)
    // Agent-initiated opens (the only caller of this webPanel branch) don't run the
    // renderer-side setActiveTab that user opens do, so tell the renderer to select it —
    // otherwise the native view shows but the tab strip stays on Chat (desynced).
    broadcast(IPC.panelsActivate, { caseSlug, packId, windowId })
    return { ok: true, panel: info }
  }

  // Shared capture path for the agent's capture_panel tool (mirrors openPanelFor).
  const capturePanelFor = (
    caseSlug: string,
    packId: string,
    windowId: string,
    mode: ModeId
  ): Promise<CapturePanelEvidence> => {
    caseWatch.suppress(caseSlug) // pre-write: capture writes a screenshot into evidence/ or artifacts/, per mode
    return capturePanelToEvidence(
      { panelHost: panelHost!, db, argusHome, detection, queue: ingestQueue, mode },
      caseSlug,
      packId,
      windowId
    )
  }

  ipcMain.handle(IPC.panelsList, (_e, caseSlug?: string) => panelHost!.list(caseSlug))
  ipcMain.handle(IPC.panelsOpen, (_e, req: OpenPanelRequest) => {
    const w = panelWindow(req.packId, req.windowId)
    if (!w) throw new Error(`unknown panel: ${req.packId}/${req.windowId}`)
    // webPanel-only by design; external apps use their own IPC (external-apps:open)
    if (w.decl.kind !== 'webPanel') throw new Error(`not a webPanel: ${req.packId}/${req.windowId}`)
    const info = panelHost!.open({
      caseSlug: req.caseSlug,
      packId: req.packId,
      windowId: req.windowId,
      title: w.decl.title,
      entry: w.decl.entry,
      // webPanel-only; Task 6 routes externalApp before this
      uiDir: w.uiDir as string,
      network: w.decl.network,
      permissions: w.decl.permissions as PanelPermission[],
      focus: req.focus,
      sessionId: req.sessionId ?? null
    })
    broadcast(IPC.panelsChanged, undefined)
    return info
  })
  ipcMain.handle(IPC.panelsClose, (_e, key: PanelKey) => {
    panelHost!.close(key)
    broadcast(IPC.panelsChanged, undefined)
  })
  ipcMain.handle(IPC.panelsFocus, (_e, key: PanelKey) => panelHost!.focus(key))
  ipcMain.handle(IPC.panelsPopOut, (_e, key: PanelKey) => {
    panelHost!.popOut(key)
    broadcast(IPC.panelsChanged, undefined)
  })
  ipcMain.handle(IPC.panelsDockBack, (_e, key: PanelKey) => {
    panelHost!.dockBack(key)
    broadcast(IPC.panelsChanged, undefined)
  })
  ipcMain.handle(IPC.panelsSetTheme, (_e, theme: 'dark' | 'light') => {
    // Assigned first, before panelHost.setTheme/broadcast below can throw: a panel-subsystem
    // throw must not leave `lastTheme` — and therefore the native chrome — stale. This is also
    // where main learns the theme at all: `lastTheme` is what a window opened later is
    // constructed with, and pushThemeIfChanged needs the PREVIOUS value to detect a no-op.
    const prevTheme = lastTheme
    lastTheme = theme
    // Skip everything below when the value hasn't actually changed. Without this, main re-pushes
    // `setTitleBarOverlay` on every renderer load — including the very first, where the value is
    // identical to the construction-time default, and every HMR reload under `electron-vite
    // dev`. The redundant-push defect this guard exists for was first observed on the MAIN
    // window's overlay — an HMR reload re-firing the identical theme was the in-diff suspect for
    // it coming up zero-width — back before the main window stopped having a native overlay at
    // all (its caption buttons are DOM now, see `pushThemeIfChanged`'s doc comment). The guard
    // stays because the editor window's overlay is subject to the identical redundant re-push.
    if (!pushThemeIfChanged(editorWindowService, theme, prevTheme)) return
    panelHost!.setTheme(theme)
    // Every BrowserWindow runs its own UiStore and reads the theme only at load, so a change
    // made in one window is invisible to the others until they reload. Fan it out here: this
    // handler already sees every theme change, including the one fired at construction.
    broadcast(IPC.uiThemeChanged, theme)
  })
  ipcMain.handle(IPC.uiSetScale, (_e, scale: number) => {
    // Same ordering rationale as panelsSetTheme above: assign before anything that could throw,
    // and skip the redundant native-overlay re-push when the value hasn't changed (e.g. an HMR
    // reload re-reporting the same persisted scale).
    const prevScale = lastScale
    lastScale = scale
    pushScaleIfChanged(editorWindowService, scale, prevScale)
  })
  // The sender's own window, not a captured `mainWindow` — see the IPC channel comments.
  const senderWindow = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)
  ipcMain.handle(IPC.windowMinimize, (e) => minimizeWindow(senderWindow(e)))
  ipcMain.handle(IPC.windowToggleMaximize, (e) => toggleMaximizeWindow(senderWindow(e)))
  ipcMain.handle(IPC.windowClose, (e) => closeWindow(senderWindow(e)))
  ipcMain.handle(IPC.windowIsMaximized, (e) => isWindowMaximized(senderWindow(e)))
  ipcMain.handle(IPC.windowIsFullScreen, (e) => isWindowFullScreen(senderWindow(e)))
  ipcMain.handle(IPC.panelsDecls, () =>
    packRegistry.windowDecls().map((w) => ({
      packId: w.packId,
      windowId: w.decl.id,
      title: w.decl.title,
      handles: w.decl.handles,
      kind: w.decl.kind
    }))
  )
  ipcMain.handle(IPC.panelsSetBounds, (_e, key: PanelKey, rect: PanelRect) =>
    panelHost!.setBounds(key, rect)
  )
  ipcMain.handle(IPC.panelsSetVisible, (_e, key: PanelKey, visible: boolean) =>
    panelHost!.setVisible(key, visible)
  )
  ipcMain.handle(IPC.panelsCloseCase, (_e, caseSlug: string) => {
    panelHost!.closeCase(caseSlug)
    externalAppHost!.closeCase(caseSlug)
    broadcast(IPC.panelsChanged, undefined)
  })

  // — external apps (3c) —
  ipcMain.handle(IPC.externalAppsList, (_e, caseSlug?: string) => externalAppHost!.list(caseSlug))
  ipcMain.handle(
    IPC.externalAppsOpen,
    (_e, req: { caseSlug: string; sessionId: number | null; packId: string; windowId: string }) =>
      openPanelFor(req.caseSlug, req.sessionId ?? 0, req.packId, req.windowId)
  )
  ipcMain.handle(IPC.externalAppsStop, (_e, key: PanelKey) => {
    externalAppHost!.stop(key)
    broadcast(IPC.panelsChanged, undefined)
  })

  // Read bridge — routed by e.sender.id (authoritative), never by renderer-supplied identity.
  ipcMain.handle(IPC.panelsGetCaseContext, (e) => {
    const b = panelHost!.bridgeForWebContents(e.sender.id)
    if (!b?.getCaseContext) throw new Error('panel bridge: getCaseContext not granted')
    return b.getCaseContext()
  })
  ipcMain.handle(IPC.panelsRequestEvidence, (e, query: string) => {
    const b = panelHost!.bridgeForWebContents(e.sender.id)
    if (!b?.requestEvidence) throw new Error('panel bridge: requestEvidence not granted')
    return b.requestEvidence(query)
  })
  ipcMain.handle(IPC.panelsReadEvidence, (e, evidenceId: number, focusLine?: number) => {
    const b = panelHost!.bridgeForWebContents(e.sender.id)
    if (!b?.readEvidence) throw new Error('panel bridge: readEvidence not granted')
    return b.readEvidence(evidenceId, focusLine)
  })
  ipcMain.handle(IPC.panelsListCaseEvidence, (e) => {
    const b = panelHost!.bridgeForWebContents(e.sender.id)
    if (!b?.listCaseEvidence) throw new Error('panel bridge: listCaseEvidence not granted')
    return b.listCaseEvidence()
  })

  // Write bridge (3b) — routed by e.sender.id; each throws when the verb is ungranted or unbound.
  ipcMain.handle(IPC.panelsSendToAgent, (e, text: string) => {
    const b = panelHost!.bridgeForWebContents(e.sender.id)
    if (!b?.sendToAgent) throw new Error('panel bridge: sendToAgent not granted')
    return b.sendToAgent(text)
  })
  ipcMain.handle(IPC.panelsEmitFinding, (e, input: { title: string; markdown: string }) => {
    const b = panelHost!.bridgeForWebContents(e.sender.id)
    if (!b?.emitFinding) throw new Error('panel bridge: emitFinding not granted')
    return b.emitFinding(input)
  })
  ipcMain.handle(IPC.panelsCite, (e, relPath: string, line: number) => {
    const b = panelHost!.bridgeForWebContents(e.sender.id)
    if (!b?.cite) throw new Error('panel bridge: cite not granted')
    return b.cite(relPath, line)
  })
  ipcMain.handle(
    IPC.panelsIngestEvidence,
    (
      e,
      input: { source: { url: string } | { bytes: ArrayBuffer | Uint8Array }; filename: string }
    ) => {
      const b = panelHost!.bridgeForWebContents(e.sender.id)
      if (!b?.ingestEvidence) throw new Error('panel bridge: ingestEvidence not granted')
      return b.ingestEvidence(input)
    }
  )
  ipcMain.handle(
    IPC.panelsSendImageToAgent,
    (e, input: { bytes: ArrayBuffer | Uint8Array; filename: string; caption?: string }) => {
      const b = panelHost!.bridgeForWebContents(e.sender.id)
      if (!b?.sendImageToAgent) throw new Error('panel bridge: sendImageToAgent not granted')
      return b.sendImageToAgent(input)
    }
  )
  ipcMain.on(
    IPC.panelsCommandResult,
    (_e, p: { requestId: string; ok: boolean; result?: unknown; error?: string }) =>
      panelHost!.resolveCommand(p.requestId, p)
  )

  // — agent —
  // Hoisted out of the AgentService literal below because the routines engine's background
  // turns are bound from the SAME values (see createRoutineTurnRunner further down): sharing
  // one binding is what keeps the two session shapes from drifting, instead of a comment asking
  // two literals to agree.
  //
  // WHAT AN UNATTENDED RUN SHARES WITH AN INTERACTIVE ONE, precisely — the shapes are close but
  // deliberately NOT identical:
  //  - shared: `skillsRoots` and `mirrorFactory` (below), plus the live agentAccess / toolRisk /
  //    packCliNames / resolvePrompt / defectCorpus sources and the same skill resolution
  //    (materializeSessionSkills + assembleMode). So a routine sees the same skills, obeys the
  //    same memory-topic and tool-risk settings, can search the same known-defects sources, and
  //    writes its transcript to the same `sessions/<id>.jsonl` mirror.
  //  - NOT shared, by decision: the persona. `assembleMode`'s persona half and the pack persona
  //    fragments are discarded for background turns, because a persona for helping a human triage
  //    a defect is not a persona for unattended automation; the automation identity comes from the
  //    unattended preamble RoutinesService prepends. See turnRunner.ts.
  //  - NOT shared, by containment: connectors (`extraMcpServers` is omitted entirely), any
  //    `permissionMode`, and `unattended: true` — see the TRUST BOUNDARY note in
  //    agent/background.ts. A background session also never enters AgentService's live map.
  //  - NOT shared, still: `referenceIndex`. Out of scope for this fix wave and left as future
  //    work — a routine is not told which team references exist.
  const skillsRoots = [
    sharedSkillsDir(argusHome),
    sharedReferencesDir(argusHome),
    graphsRoot(argusHome)
  ]
  const mirrorFactory = (caseSlug: string, sessionId: number): SessionMirror =>
    new SessionMirror(
      db,
      path.join(caseDir(argusHome, caseSlug), 'sessions', `${sessionId}.jsonl`),
      {
        caseId: listCases(db).find((c) => c.slug === caseSlug)?.id ?? 0,
        sessionId
      }
    )
  agentService = new AgentService({
    db,
    argusHome,
    detection,
    queue: ingestQueue,
    skillsRoots,
    personaFragments: () => packRegistry.personaFragments(),
    referenceIndex: () =>
      buildReferenceIndex(sharedReferencesDir(argusHome), refSyncStore.get(), resolvePrompt),
    packCliNames: () => packRegistry.binaryDecls().flatMap(({ decl }) => decl.names),
    resolvePrompt,
    activeOverrides: () => promptStore.activeOverrideIds(),
    // Undefined, not a no-op: with the gate off CaseSession must not even assemble a record.
    ...(promptCaptures.enabled
      ? { recordPromptCapture: (c: SessionPromptCapture) => promptCaptures.record(c) }
      : {}),
    onEvent: (e) => {
      // Compare what the CLI actually adopted against what Argus asked for, and record a
      // mismatch as a refusal on the session's provider instance. Extracted to
      // modeRefusals.ts's recordRefusalFor (instance lookup + the requested-mode fallback
      // shared with registry.ts, see that function's doc) so this comparison has a unit test
      // reaching it directly rather than only through the whole app's event wiring.
      //
      // Deliberately NOT wired at the routines (unattended) sink below: an unattended run's
      // mode is downgraded to `default` before it ever starts (Task 2), so it can never
      // legitimately observe a refusal there — recording from it would only add noise.
      if (e.type === 'session.started' && e.payload.effectivePermissionMode != null) {
        recordRefusalFor(
          {
            db,
            registry: modeRefusals,
            defaultPermissionMode: settingsService.get().agent.defaultPermissionMode
          },
          { sessionId: e.sessionId, effectivePermissionMode: e.payload.effectivePermissionMode }
        )
      }
      langfuseExporter?.handle(e)
      broadcast(IPC.agentEventChannel, e)
    },
    agentAccess: () => agentAccessStore.get(),
    agentSettings: () => settingsService.get().agent,
    // Thunk, not a resolved value: AgentService re-invokes this at every getOrCreate, so
    // switching the active provider in settings takes effect on the NEXT session without
    // an app restart (Phase 3 checkpoint item 5).
    driver: () => getActiveDriver(settingsService.get().agent),
    driverForInstance: (instanceId) =>
      resolveInstanceDriver(settingsService.get().agent, instanceId).driver,
    composeMcp: () => mcpService.composeForSession(),
    onAuthFailure: () => authCache.onAuthFailure(),
    onAuthVerified: () => authCache.onAuthVerified(),
    toolRisk: () => toolRiskStore.get(),
    // Thunk, not a resolved value: editing the watermark in Settings takes effect on the next
    // post without restarting the session.
    githubWatermark: () => settingsService.get().watermark.github,
    openPanel: openPanelFor,
    capturePanel: capturePanelFor,
    panelCommandDecls: () => flattenPanelCommands(packRegistry.windowDecls()),
    onCaseClosed,
    onWorktreeChanged: (slug) => broadcast(IPC.workspacesChanged, slug),
    defectCorpus,
    processLabels: defaultProcessLabels,
    // A routine's background session is streamed into the normal case UI but is NOT in
    // AgentService's live map, so an attach would build a second, fully-permissioned session on
    // the same row. Refuse instead, with a reason the renderer can show.
    sessionUnavailable: (sessionId) => {
      const routineId = runningRoutineForSession(db, sessionId)
      return routineId
        ? `This chat is running the routine "${routineId}" unattended right now. Wait for the run to finish before sending a message.`
        : null
    },
    dispatchPanelCommand: (caseSlug, packId, windowId, cmd, args) => {
      const w = panelWindow(packId, windowId)
      return w?.decl.kind === 'externalApp'
        ? externalAppHost!.dispatchToProcess({ caseSlug, packId, windowId }, cmd, args)
        : panelHost!.dispatchToPanel({ caseSlug, packId, windowId }, cmd, args)
    },
    mirrorFactory
  })
  ipcMain.handle(
    IPC.agentSend,
    (_e, caseSlug: string, sessionId: number, text: string, composed?: boolean) => {
      return agentService!.send(caseSlug, sessionId, text, { composed: composed === true })
    }
  )
  ipcMain.handle(IPC.agentInterrupt, (_e, caseSlug: string, sessionId: number) => {
    return agentService!.interrupt(caseSlug, sessionId)
  })
  ipcMain.handle(
    IPC.agentRespond,
    (_e, caseSlug: string, sessionId: number, d: ApprovalDecision) => {
      return agentService!.respond(caseSlug, sessionId, d)
    }
  )
  ipcMain.handle(
    IPC.agentAnswerDialog,
    (_e, caseSlug: string, sessionId: number, a: DialogAnswer) => {
      return agentService!.answerDialog(caseSlug, sessionId, a)
    }
  )
  ipcMain.handle(IPC.agentAuthStatus, (_e, force?: boolean) => authCache.get(force ?? false))
  ipcMain.handle(IPC.providerStatuses, () => providerStatusService?.list() ?? [])
  ipcMain.handle(IPC.providerRefresh, async () => {
    // The one user gesture the design treats as "policy may have changed, go find out": clear
    // recorded refusals before probing, so a user who just had an org policy lifted gets the
    // permission-mode option back without restarting. Contrast with the periodic/settings-
    // triggered refreshAll() below, which deliberately leaves the registry alone.
    modeRefusals.clear()
    await providerStatusService?.refreshAll()
    return providerStatusService?.list() ?? []
  })
  ipcMain.handle(IPC.agentPreflight, () => binariesService.preflight())
  ipcMain.handle(IPC.agentHistory, (_e, caseSlug: string, sessionId: number) => {
    assertSlug(caseSlug)
    if (!Number.isInteger(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
    return readSessionEvents(caseDir(argusHome, caseSlug), sessionId)
  })
  // The composer needs each model's option descriptors (effort levels, 1M context,
  // adaptive thinking) before any session/query exists. Only the Claude driver has a
  // runtime catalog; every other instance returns [] rather than something speculative,
  // so option controls never appear on a model that cannot honour them.
  ipcMain.handle(IPC.modelsCatalog, async (_e, instanceId: string) => {
    const settings = settingsService.get()
    const inst = settings.agent.providerInstances[instanceId]
    if (!inst?.enabled) return []
    const resolved = resolveInstanceDriver(settings.agent, instanceId)
    if (resolved.driver.kind !== 'claude-agent-sdk') return []
    const cfg = driverConfig<AgentDriverConfig>(resolved.driver.kind, inst.config)
    return fetchCatalog(createClaudeQuery, cfg.cliPath ? { cliPath: cfg.cliPath } : {})
  })
  // A new chat is seeded with the DEFAULT provider instance and its default model, pinned
  // at creation. The user can re-pin it from the composer's model picker afterwards.
  const newSessionProvider = (): {
    driverKind: string
    instanceId: string | null
    model: string | null
  } => {
    const settings = settingsService.get()
    const ref = defaultModelRef(settings)
    return {
      driverKind: getActiveDriver(settings.agent).kind,
      instanceId: ref?.instanceId ?? null,
      model: ref?.slug ?? null
    }
  }
  ipcMain.handle(IPC.sessionsList, (_e, caseSlug: string) =>
    listSessions(db, caseSlug, newSessionProvider(), getCase(db, caseSlug)?.activeMode)
  )
  ipcMain.handle(IPC.sessionsCreate, (_e, caseSlug: string) =>
    createSession(db, caseSlug, {
      ...newSessionProvider(),
      mode: getCase(db, caseSlug)?.activeMode
    })
  )
  ipcMain.handle(
    IPC.sessionsSetModel,
    (_e, sessionId: number, instanceId: string, model: string) => {
      if (!Number.isInteger(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
      const settings = settingsService.get()
      const inst = settings.agent.providerInstances[instanceId]
      // Reject an unknown/disabled instance rather than silently pinning to it: the picker
      // only ever offers enabled instances, so this is a malformed request, and pinning a
      // session to a provider that cannot run would strand the chat.
      if (!inst?.enabled) throw new Error(`Unknown or disabled provider instance: ${instanceId}`)
      const previousInstanceId = sessionProvider(db, sessionId)?.instanceId ?? null
      const changed = setSessionModel(db, sessionId, {
        driverKind: resolveInstanceDriver(settings.agent, instanceId).driver.kind,
        instanceId,
        model
      })
      // A session's permission_mode is only ever validated against the global PERMISSION_MODES
      // (assertPermissionMode), not the driver actually in play — this branch is the first
      // place a re-pin can move a session onto a driver whose own permissionModes doesn't
      // include the mode it's already pinned to (e.g. 'auto' onto Copilot/Codex/ACP, none of
      // which offer it). Reset to 'default' rather than leave the DB naming a mode the new
      // driver has no menu entry for; see reconcilePermissionModeForDriver's doc for the full
      // failure mode this avoids.
      //
      // Gated on the instance actually changing, so a re-pin to the SAME instance whose driver
      // was swapped out from under it in settings does NOT reconcile here — `previousInstanceId
      // !== instanceId` is false in that case. That gap is real but out of scope for this pass;
      // the session keeps a stale pin until it moves to a different instance.
      if (previousInstanceId !== instanceId) {
        reconcilePermissionModeForDriver(
          db,
          sessionId,
          resolveInstanceDriver(settings.agent, instanceId).driver.capabilities.permissionModes
        )
      }
      // The live CaseSession has the old model frozen at query() construction; AgentService
      // compares modelKey on the next send and rebuilds. Nothing to do here.
      //
      // permissionMode is read back (rather than derived by the caller) so the renderer learns
      // the RECONCILED value in one round trip: reconcilePermissionModeForDriver may just have
      // reset it server-side, and the renderer's cached session row has no way to know that on
      // its own — see sessionsStore.patch in CaseWorkspace.tsx's handleModelChange.
      return { changed, permissionMode: sessionPermissionMode(db, sessionId) }
    }
  )
  ipcMain.handle(
    IPC.sessionsSetRunOptions,
    (_e, sessionId: number, sel: { id: string; value: string | boolean }[]) => {
      if (!Number.isInteger(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
      if (!Array.isArray(sel))
        throw new Error(`Run options must be an array, received ${typeof sel}`)
      // Shape-only guard: the renderer has already pruned selections against the
      // current model's descriptors, and the model catalog is not reachable from
      // this layer. Persisting here does NOT retune a live CaseSession — its options
      // are still frozen at query() construction — but registry.ts now folds
      // sessionRunOptions/sessionPermissionMode into optionsKey and compares it on the
      // next send, so the running session is torn down and rebuilt instead of the
      // change being silently ignored. The rebuild DOES make the new selections take
      // effect: the Claude driver now reads ctx.runOptions (queryOptions.ts) when the
      // rebuilt session's query() is constructed, resolving each selection against that
      // session's model catalog entry (catalog.ts).
      return setSessionRunOptions(db, sessionId, sel)
    }
  )
  ipcMain.handle(IPC.sessionsSetPermissionMode, (_e, sessionId: number, mode: unknown) => {
    if (!Number.isInteger(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
    assertPermissionMode(mode)
    return setSessionPermissionMode(db, sessionId, mode)
  })
  ipcMain.handle(IPC.sessionsRename, (_e, sessionId: number, title: string) =>
    renameSession(db, sessionId, title)
  )
  ipcMain.handle(IPC.sessionsDelete, async (_e, caseSlug: string, sessionId: number) => {
    assertSlug(caseSlug)
    if (!Number.isInteger(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
    // stop any live session first: stop() closes the mirror synchronously, flushing
    // its write-behind buffer before we rmSync the .jsonl below — otherwise the
    // pending 250ms flush timer would recreate the file after deletion
    await agentService!.stopSession(caseSlug, sessionId)
    deleteSession(db, argusHome, caseSlug, sessionId)
  })
  ipcMain.handle(IPC.casesSetMode, async (_e, caseSlug: string, mode: ModeId) => {
    assertSlug(caseSlug)
    // Reject a mode that isn't a real MODES key rather than persisting it: an arbitrary
    // string in the mode column makes MODES[mode] undefined, which throws on every later
    // send (assembleMode) and on every render (ModeSwitcher) — and it's persisted, so it
    // would survive a restart with no recovery path.
    if (!(mode in MODES)) throw new Error(`Unknown mode: ${mode}`)
    // Reject a mode the case cannot run right now: the switcher only ever offers available
    // modes, so this is a malformed request, and switching a case into a mode that cannot
    // run would strand the chat — same rationale as the sessionsSetModel guard above.
    const available = availableModes(modeContextForCase(db, caseSlug))
    if (!available.includes(mode)) {
      throw new Error(`Mode not available for this case: ${mode}`)
    }
    const { sessionId, materialized } = await setCaseMode(
      db,
      argusHome,
      caseSlug,
      mode,
      newSessionProvider(),
      { materialize: prMaterializer(argusHome, caseSlug) }
    )
    // Repo chips read worktree state, so a freshly checked-out PR must announce itself.
    // The session's own sandbox needs no refresh: workspaceSandboxRoots covers the whole
    // worktreesRoot and is computed once at session construction (agent/registry.ts:224),
    // and a mode switch always lands on a different session — do not "optimize" a mode
    // switch into reusing the live one.
    //
    // Twice, for the same reason as prLink's pair: once now, so the rail reacts to the mode
    // it is actually in, and once when the checkout lands, because THAT is when the worktree
    // the chips report on comes into existence. `materialized` never rejects, so the second
    // one cannot become an unhandled rejection in main. Only `sessionId` is returned —
    // `materialized` is a Promise and does not survive structured clone.
    if (mode === 'review') {
      broadcast(IPC.workspacesChanged, caseSlug)
      void materialized.then(() => broadcast(IPC.workspacesChanged, caseSlug))
    }
    return { sessionId }
  })

  // — routines (saved prompt + trigger, run unattended) —
  //
  // This is the ONLY place Electron and the routines engine meet. `services/routines/*` and
  // `agent/background.ts` import no electron at all, so a future headless server can host them;
  // everything window-shaped enters through the two callbacks bound below.
  //
  // BOTH CALLBACKS MUST BE NON-THROWING, and that is load-bearing rather than defensive.
  // `broadcast` really can throw: `webContents.send` on a window destroyed mid-iteration —
  // app quit, or a window closing while a routine streams — raises "Object has been
  // destroyed". Each of the three call sites turns that into a different, worse failure:
  //  - `notify` right after `insertRoutineRun` (service.ts) sits OUTSIDE the try/catch that
  //    records a run's outcome. A throw there escapes `execute()` to startRun's `.catch()`,
  //    which only logs — leaving the freshly-opened row `running` for the rest of the session,
  //    the one state the service is built to make impossible. Nothing is actually blocked: the
  //    busy check reads the in-memory `running` flag, which the `.finally()` still clears, so
  //    later runs start normally. The damage is the row itself, which the UI renders as a
  //    routine executing forever — until the next launch, where reconcileInterruptedRuns
  //    (wired below) closes it out as failed.
  //  - `notify` after `attachRunSession` is INSIDE that try, so a throw is recorded as a
  //    FAILED run: a perfectly good routine reported as broken because a window closed.
  //  - `notify` in the `.finally()` runs after `this.running = null`, so the flag is safe,
  //    but the throw rejects the promise `whenIdle()` hands to every test that awaits it, and
  //    nothing follows the `.finally()` to catch it — an unhandled rejection.
  // `onEvent` is the first statement of runBackgroundTurn's `emit`, ahead of the switch that
  // decides the turn's outcome, so a throw would skip `settle()` for that event entirely: no
  // result, no teardown, and the turn only ends when its timeout eventually fires.
  const routinesBroadcast = (channel: string, payload: unknown): void => {
    try {
      broadcast(channel, payload)
    } catch (err) {
      // Logged, never rethrown: losing one UI refresh is strictly better than losing the run.
      console.error(`[routines] broadcast on ${channel} failed:`, err)
    }
  }
  // showMainWindow(), then land on the run inbox — the tray's "N runs to review" item and a
  // clicked run-finished notification both mean this (both wired further down, still inside this
  // function).
  //
  // The tray-resident case (no window open) is the PRIMARY case for both callers, and that is
  // exactly the case where a broadcast sent right after `showMainWindow()` returns would be sent
  // into a `webContents` that has only just started `loadFile`/`loadURL` — no renderer listener
  // registered yet, message silently dropped. A prior fix deferred the broadcast to that window's
  // `did-finish-load`, but that traded one race for another: App.tsx subscribes to
  // routines:focus-inbox from a `useEffect`, and React does not guarantee that effect has flushed
  // by the time `did-finish-load` fires. Inverted instead — set `pendingFocusInbox` here and let
  // the renderer ask for it on mount (`routines:consume-focus-inbox`, handled below), which has no
  // timing question at all. When the window already existed, push immediately as before; that path
  // has a live listener and no race.
  const showMainWindowAndFocusInbox = (): void => {
    const created = showMainWindow()
    if (created) {
      pendingFocusInbox = true
      return
    }
    routinesBroadcast(IPC.routinesFocusInbox, null)
  }
  // Local const published to the module-scope handle (same idiom as `flushTabs` above), so the
  // handlers below can use it without a non-null assertion on a `let` that quit-time sets aside.
  const routines = new RoutineStore(argusHome)
  routineStore = routines
  // Startup reconciliation, and this is the only correct moment for it. The service's "no run is
  // ever left `running`" guarantee holds within a process; a crash or a quit mid-run breaks it
  // across processes, and nothing else ever revisits those rows. Placed HERE — before the
  // `ipcMain.handle` calls below — because `routinesRunNow` is the only way to reach `startRun`,
  // so no run of this process can be in flight yet and the `status='running'` predicate can only
  // match rows left by a previous one. Deliberately not in RoutinesService's constructor: see the
  // contract on reconcileInterruptedRuns.
  const strandedRuns = reconcileInterruptedRuns(db)
  if (strandedRuns > 0) {
    console.warn(
      `[routines] marked ${strandedRuns} run(s) failed: still 'running' from a previous session`
    )
  }

  // `jiraCases` is constructed HERE — hoisted up from its old spot near the rest of the "jira
  // case lifecycle" handlers below — specifically so `buildJiraScopeResolver` (right after) can
  // take it as a plain, already-built argument instead of closing over a `const` declared further
  // down in this same function. The earlier version of this file DID close over a later `const`,
  // justified by a comment claiming `registerIpc()` always finishes building every one of its
  // `const`s before either resolver method could run. That claim was false as a general
  // guarantee — the scheduler's `start()` call a bit further down fires its first tick
  // SYNCHRONOUSLY, and that tick sits well before the old `jiraCases` declaration. It happened
  // not to matter only because the synchronous path to a jira-scoped item always crosses an
  // `await` on a real network call first (`atlassian.searchIssues`) — true today, but incidental
  // and easy to invalidate with a caching layer or a synchronous first-page short-circuit.
  // Hoisting removes the ordering dependency entirely rather than re-documenting it.
  const jiraCases = new JiraCases({
    db,
    argusHome,
    detection,
    client: atlassian,
    // Read only after a successful client call (getIssue) already warmed the
    // discovery cache for this instance, so the sync cache read is safe here —
    // resolveSiteUrl's async discovery path is not needed on this hot path.
    site: () => atlassian.cachedSiteUrl(rovoInstanceId(connectorRegistry.get()) ?? '') ?? '',
    queue: ingestQueue,
    emitProgress: (p) => broadcast(IPC.jiraAttachmentProgress, p),
    evidenceChanged: evidenceChangedB,
    resolvePrompt
  })

  // The jira half of ScopeResolver. Lives HERE, not in services/routines/, because it needs the
  // Atlassian client and the ingest path — neither of which the engine may import. The actual
  // JQL-building and adopt/create logic lives in jiraScopeResolver.ts (electron-free, so it is
  // directly unit-testable), and this is just its Electron-adjacent binding: `db` and `atlassian`
  // are already constructed above, `jiraCases` immediately above.
  const scopeResolver: ScopeResolver = buildJiraScopeResolver({ db, atlassian, jiraCases })

  const routinesService = new RoutinesService({
    db,
    argusHome,
    store: routines,
    scopeResolver,
    // The binding itself lives in services/routines/turnRunner.ts — electron-free, so it is
    // reachable by a runtime test, unlike anything written inline here. It also owns the
    // driver-kind mismatch guard: getDriverByKind falls back to Claude for any unregistered
    // kind, which would execute a run on a provider the session row does not name.
    runTurn: createRoutineTurnRunner({
      db,
      argusHome,
      detection,
      queue: ingestQueue,
      skillsRoots,
      driverFor: getDriverByKind,
      // The same live sources AgentService is given above. Skipping any of them does not make
      // an unattended run "smaller" — it makes it differently-shaped: no skills at all, pack
      // CLIs denied, and (agentAccess) memory topics the user disabled injected anyway.
      agentAccess: () => agentAccessStore.get(),
      toolRisk: () => toolRiskStore.get(),
      packCliNames: () => packRegistry.binaryDecls().flatMap(({ decl }) => decl.names),
      resolvePrompt,
      // Same value AgentService is given above (line ~1631) — not a second corpus service, so
      // both session shapes search the same configured sources.
      defectCorpus,
      githubWatermark: () => settingsService.get().watermark.github,
      // Same channel as an interactive turn, so a routine's transcript streams into the
      // normal session UI while it runs; `mirrorFactory` is what makes it replayable after.
      // Deliberately does NOT record mode refusals (contrast the interactive sink above,
      // ~line 1648): an unattended run's permission mode is downgraded to `default` before
      // it ever starts (Task 2), so it can never legitimately observe a refusal — wiring
      // this sink to modeRefusals would only add noise.
      onEvent: (e) => routinesBroadcast(IPC.agentEventChannel, e),
      mirrorFactory
    }),
    notify: () => {
      routinesBroadcast(IPC.routinesChanged, null)
      trayService?.refresh()
    },
    onRunFinished: (info) => {
      // The rule is one input: was there a window the user can actually see right now? A
      // scheduled run finishing while the user watches needs no notification — the inbox
      // already updated through routines:changed. A MANUAL run whose window was closed
      // mid-flight does need one, which is why this asks about the window rather than about
      // info.trigger. A minimized window still reports isVisible() === true, so that has to be
      // excluded explicitly — don't simplify this back down to isVisible() alone.
      const visible =
        !!mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.isVisible() &&
        !mainWindow.isMinimized()
      if (visible || !Notification.isSupported()) return
      const n = new Notification({
        title: info.routineName,
        body:
          info.status === 'ok'
            ? info.summary?.split('\n')[0] || 'Run finished'
            : (info.error ?? `Run ${info.status}`)
      })
      liveNotifications.add(n)
      n.on('click', () => {
        liveNotifications.delete(n)
        showMainWindowAndFocusInbox()
      })
      n.on('close', () => {
        liveNotifications.delete(n)
      })
      n.show()
    }
  })
  routinesServiceHandle = routinesService
  // File-level changes (an edit through the IPC handlers below, or someone editing
  // config/routines.json by hand) announce through the store's own watcher; run-level changes
  // announce through `notify`. Both land on the same channel, and listeners re-read rather than
  // trusting the payload, so a double announce is harmless.
  routines.subscribe(() => {
    routinesBroadcast(IPC.routinesChanged, null)
    trayService?.refresh()
  })

  ipcMain.handle(IPC.routinesList, (): RoutinesPayload => routinesService.payload())
  // Static data, imported straight from services/routines/templates.ts — no store, no db, no
  // broadcast. The list never changes at runtime, so there is nothing to keep in sync.
  ipcMain.handle(IPC.routinesTemplates, (): readonly RoutineTemplate[] => ROUTINE_TEMPLATES)
  ipcMain.handle(IPC.routinesSave, (_e, routine: unknown): RoutinesPayload => {
    // `unknown`, deliberately: IPC arguments are untyped at runtime and the store zod-validates.
    routines.upsert(routine)
    return routinesService.payload()
  })
  ipcMain.handle(IPC.routinesDelete, (_e, id: string): RoutinesPayload => {
    routines.remove(id)
    // The store owns config/routines.json; the engine owns db rows keyed by the same id. Ids are
    // derived from the routine's name, so recreating a deleted routine lands on the same id —
    // and a surviving schedule anchor would make it overdue the instant it was saved.
    routinesService.forgetRoutine(id)
    return routinesService.payload()
  })
  ipcMain.handle(IPC.routinesRunNow, (_e, id: string): RoutinesPayload => {
    // Throws (unknown / disabled) straight back to the renderer; a busy engine no longer throws —
    // the id is queued instead. The payload returned on success already carries `runningId` and
    // `queued`, so the caller needs no second read.
    routinesService.startRun(id)
    return routinesService.payload()
  })

  // The service notifies on both, which fans out as `routines:changed`. Returning the payload
  // as well is not redundant: the caller gets its own answer synchronously with the click, and
  // every OTHER window (and the Settings page in this one) converges on the broadcast. A
  // renderer store refreshed only by its own invoke reply is the multi-window bug this product
  // has already shipped twice.
  ipcMain.handle(IPC.routinesMarkReviewed, (_e, runId: number): RoutinesPayload => {
    routinesService.markReviewed(runId)
    return routinesService.payload()
  })
  ipcMain.handle(IPC.routinesMarkAllReviewed, (): RoutinesPayload => {
    routinesService.markAllReviewed()
    return routinesService.payload()
  })
  ipcMain.handle(IPC.routinesAcceptItem, (_e, itemId: number): RoutinesPayload => {
    routinesService.acceptItem(itemId)
    return routinesService.payload()
  })
  ipcMain.handle(
    IPC.routinesDismissItem,
    (_e, itemId: number, resolution: CaseResolution): RoutinesPayload => {
      // A missing OR bogus resolution must reject rather than close a case with no (real)
      // explanation attached. IPC arguments are untyped at runtime — `resolution` is only
      // `CaseResolution` by annotation, not by anything the renderer is prevented from sending —
      // so a truthiness check alone lets an arbitrary non-empty string through.
      if (!resolution || !CASE_RESOLUTIONS.includes(resolution)) {
        throw new Error('Dismissing a draft requires a resolution reason')
      }
      routinesService.dismissItem(itemId, resolution)
      return routinesService.payload()
    }
  )

  // Consume-once read: App.tsx calls this on every mount (including the very first, freshly
  // created window) so it can land on the inbox without waiting on a push it might not be
  // listening for yet. Clearing the flag on read means a second window, or a later remount of the
  // same window, correctly sees nothing pending.
  ipcMain.handle(IPC.routinesConsumeFocusInbox, (): boolean => {
    const pending = pendingFocusInbox
    pendingFocusInbox = false
    return pending
  })

  // Scheduling, and this is the only correct moment to start it. `start()` runs its first tick
  // SYNCHRONOUSLY — that tick is the launch catch-up — so a run can begin on this very line.
  // It must therefore come after `reconcileInterruptedRuns` above (a catch-up run inserting a
  // `running` row before the reconcile would have that row rewritten as failed underneath it)
  // and after the handlers above (a run beginning against a half-registered host).
  //
  // A routine that has never run is anchored on the persisted `routine_anchors` row written the
  // first time it is seen with a live schedule (anchors.ts), NOT on this process's start — so a
  // routine saved hours into a session fires at its next natural occurrence rather than being
  // already overdue, and a long-interval one converges instead of receding on every launch.
  routineScheduler = new RoutineScheduler({
    store: routines,
    service: routinesService
  })
  routineScheduler.start()

  // After the scheduler, so the first menu it builds already reflects any catch-up run that the
  // synchronous first tick just queued.
  trayService = new TrayService({
    createTray: (image) => new Tray(image as Electron.NativeImage),
    buildMenu: (template) =>
      Menu.buildFromTemplate(template as Electron.MenuItemConstructorOptions[]),
    icon: () => {
      // macOS wants a monochrome template image so the menu bar can invert it with the theme;
      // everywhere else renders the image as given.
      if (process.platform === 'darwin') {
        const img = nativeImage.createFromPath(trayTemplatePng)
        img.setTemplateImage(true)
        return img
      }
      return nativeImage.createFromPath(trayIconPng)
    },
    unreviewedCount: () => routinesService.payload().unreviewedCount,
    showWindow: () => showMainWindow(),
    showWindowAndFocusInbox: () => showMainWindowAndFocusInbox(),
    quit: () => app.quit()
  })
  trayService.start()

  // — modes —
  ipcMain.handle(IPC.modesAvailable, (_e, caseSlug: string) => {
    assertSlug(caseSlug)
    return availableModes(modeContextForCase(db, caseSlug))
  })

  // — review —
  // Composes here rather than in the renderer because the PR binding, the worktree path and
  // the session's provider all live in main. The composed text then goes out through the
  // ordinary agent send path, so a review run queues, cancels and mirrors like a typed message.
  // The handler body lives in reviewRunCompose.ts (thin wrapper here) so it is testable without
  // booting Electron; the driver resolution inside it mirrors AgentService's own exactly
  // (reviewFraming.ts's driverForSession — same `driverForInstance`/`resolveDriver` shape
  // AgentService is constructed with below).
  ipcMain.handle(
    IPC.reviewComposeRunPrompt,
    (_e, caseSlug: string, sessionId: number, layerIds: string[]) =>
      composeReviewRunPrompt(
        {
          db,
          getBinding,
          materialize: prMaterializer(argusHome, caseSlug),
          resolvePrompt,
          driverForInstance: (instanceId) =>
            resolveInstanceDriver(settingsService.get().agent, instanceId).driver,
          resolveDriver: () => getActiveDriver(settingsService.get().agent)
        },
        caseSlug,
        sessionId,
        layerIds
      )
  )

  // Composes the two finding write-action turns (post a comment, apply + push) the same way —
  // main owns the binding and worktree path, and the composed text goes out through the
  // ordinary agent send path.
  ipcMain.handle(
    IPC.reviewComposeActionPrompt,
    (_e, caseSlug: string, sessionId: number, findingIds: number[], action: string) =>
      composeReviewActionPrompt(
        {
          db,
          argusHome,
          resolvePrompt,
          // ReviewWriteDeps.resolve is the seam findingForCase/resolveCommentTarget use for
          // their throw text; resolvePrompt is the one buildReviewActionPrompt uses. Both are
          // the same registry — pass both or half the strings ignore the user's overrides.
          resolve: resolvePrompt,
          driverForInstance: (instanceId) =>
            resolveInstanceDriver(settingsService.get().agent, instanceId).driver,
          resolveDriver: () => getActiveDriver(settingsService.get().agent)
        },
        caseSlug,
        sessionId,
        findingIds,
        action
      )
  )

  // Button-initiated comment post (Plan 6 §1, Task 4): main-owned mechanism, no model turn.
  ipcMain.handle(
    IPC.reviewPostFindingComment,
    (_e, slug: string, sessionId: number, findingId: number) => {
      assertSlug(slug)
      return agentService!.postFindingComment(slug, sessionId, findingId)
    }
  )

  // The PR worktree's current head, for the findings pane's stale-finding chip (Task 7b): a
  // finding's citation preview is pinned to `head_sha`, and this tells the renderer when that
  // no longer matches what's actually checked out.
  ipcMain.handle(IPC.reviewWorktreeHead, (_e, slug: string) => {
    assertSlug(slug)
    return prWorktreeHead({ db, argusHome }, slug)
  })

  // The companion's Analyze button. Same posture as the two above — main owns the binding and
  // the worktree path — but no framing deps: a CI triage turn is single-pass, so it never asks
  // which driver the session runs on.
  ipcMain.handle(
    IPC.reviewComposeCiPrompt,
    (_e, caseSlug: string, sessionId: number, checkName: string) =>
      composeCiTriagePrompt(
        { db, argusHome, resolvePrompt, resolve: resolvePrompt },
        caseSlug,
        sessionId,
        checkName
      )
  )

  // — case extras —
  ipcMain.handle(IPC.caseCost, (_e, caseSlug: string) => {
    return db
      .prepare(
        `SELECT COALESCE(SUM(t.input_tokens),0) AS inputTokens,
                COALESCE(SUM(t.output_tokens),0) AS outputTokens,
                COALESCE(SUM(t.cost_usd),0) AS costUsd
         FROM turns t JOIN cases c ON c.id = t.case_id WHERE c.slug = ?`
      )
      .get(caseSlug)
  })
  ipcMain.handle(IPC.caseReadFindings, (_e, caseSlug: string) => {
    const f = path.join(caseDir(argusHome, caseSlug), 'findings.md')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  })

  // — observability: metrics + findings —
  ipcMain.handle(IPC.metricsGlobal, (_e, q?: MetricsQuery) => globalMetrics(db, q))
  ipcMain.handle(IPC.metricsCase, (_e, caseSlug: string, q?: MetricsQuery) =>
    caseMetrics(db, caseSlug, q)
  )
  ipcMain.handle(IPC.usageStats, () =>
    usageStats({
      db,
      argusHome,
      access: agentAccessStore.get(),
      hygiene: settingsService.get().memoryHygiene
    })
  )
  ipcMain.handle(IPC.findingsList, (_e, caseSlug: string) => listFindings(db, argusHome, caseSlug))
  ipcMain.handle(IPC.findingsReview, (_e, id: number, state: ReviewState) => {
    const row = reviewFinding(db, id, state)
    langfuseExporter?.scoreFinding(row)
    return row
  })
  ipcMain.handle(IPC.findingsClear, (_e, caseSlug: string, mode?: ModeId) => {
    assertSlug(caseSlug)
    // IPC args are untrusted: an unknown mode must not silently no-op or clear everything.
    if (mode !== undefined && mode !== 'investigation' && mode !== 'review')
      throw new Error(`Invalid mode: ${JSON.stringify(mode)}`)
    return clearFindings(db, argusHome, caseSlug, mode)
  })
  ipcMain.handle(IPC.findingsDelete, (_e, id: number) => deleteFinding(db, argusHome, id))

  // — workspaces —
  ipcMain.handle(IPC.workspacesPick, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  // Both link paths broadcast: linking/unlinking a repo changes which MODES are available
  // (review needs one), and the mode switcher caches that list — without a signal it keeps
  // offering a Review button the handler below then rejects. Same broadcast the repo chips
  // already consume.
  ipcMain.handle(IPC.workspacesLink, async (_e, caseSlug: string, repoPath: string) => {
    assertSlug(caseSlug)
    assertRepoPath(repoPath)
    const workspace = await linkWorkspace(db, argusHome, caseSlug, repoPath)
    // Counting lives HERE, not in linkWorkspace: `autoLinkDefaultRepo` calls that function
    // directly and must never count toward the promote threshold, or a repo that is already
    // a default would trip a prompt asking it to become one.
    recordLink(db, repoPath, caseSlug)
    broadcast(IPC.workspacesChanged, caseSlug)
    return {
      workspace,
      suggestDefault: shouldSuggestDefault(
        db,
        repoPath,
        settingsService.get().general.defaultRepos
      ),
      caseCount: caseCount(db, repoPath)
    }
  })
  ipcMain.handle(IPC.workspacesRecent, () => listRecent(db))
  ipcMain.handle(IPC.workspacesDismissPromote, (_e, repoPath: string) => {
    assertRepoPath(repoPath)
    dismissPromote(db, repoPath)
  })
  ipcMain.handle(IPC.workspacesSetDefault, (_e, repoPath: string) => {
    assertRepoPath(repoPath)
    const current = settingsService.get().general.defaultRepos
    const key = repoKey(repoPath)
    if (current.some((d) => repoKey(d) === key)) return
    settingsService.patch({ general: { defaultRepos: [...current, repoPath] } })
  })
  ipcMain.handle(IPC.workspacesUnlink, async (_e, caseSlug: string, repoPath: string) => {
    await unlinkWorkspace(db, argusHome, caseSlug, repoPath)
    // Unlinking the last repo takes review mode away; a case left sitting in it would be
    // stranded with an unclickable switcher.
    await demoteIfModeUnavailable(db, argusHome, caseSlug, newSessionProvider())
    broadcast(IPC.workspacesChanged, caseSlug)
  })
  ipcMain.handle(IPC.workspacesList, (_e, caseSlug: string) =>
    listWorkspaces(db, argusHome, caseSlug)
  )
  // — pull requests —
  // Unlike the workspaces:* handlers above (a known gap), every pr:* handler validates
  // the slug before it reaches the DB or the filesystem.
  // The handler body lives in prLink.ts (thin wrapper here) so the picker/manual parsing
  // split and the shared materialize+broadcast side effect are testable without booting
  // Electron. (Both paths run the same side effect now — see linkPrForCase's doc comment.)
  //
  // Only `binding` crosses the wire. `materialized` is a live Promise — not structured-
  // cloneable — and deliberately un-awaited: the checkout it stands for is a `git fetch` +
  // `worktree add` that the caller must not sit on. It re-broadcasts on its own (see
  // linkPrForCase), so nothing here has to chain onto it.
  ipcMain.handle(IPC.prLink, async (_e, caseSlug: string, input: string | PrRef) => {
    const { binding } = await linkPrForCase(
      {
        db,
        argusHome,
        materialize: prMaterializer(argusHome, caseSlug),
        broadcast: (slug) => broadcast(IPC.workspacesChanged, slug)
      },
      caseSlug,
      input
    )
    return binding
  })
  ipcMain.handle(IPC.prList, (_e, caseSlug: string) => {
    assertSlug(caseSlug)
    return listBindings(db, caseSlug)
  })
  ipcMain.handle(IPC.prStatusList, (_e, caseSlugs: string[]) =>
    readPrStatuses(db, Array.isArray(caseSlugs) ? caseSlugs : [])
  )
  ipcMain.handle(IPC.prStatusRefresh, async (_e, caseSlugs: string[]) => {
    const slugs = Array.isArray(caseSlugs) ? caseSlugs : []
    const out = await refreshPrStatuses({ db }, slugs)
    // Broadcast the slugs that actually changed, so a second window's dashboard repaints
    // without re-fetching. The payload is slugs, not statuses: every listener reads the cache.
    if (Object.keys(out).length > 0) broadcast(IPC.prStatusChanged, Object.keys(out))
    return out
  })
  ipcMain.handle(IPC.prUnlink, (_e, caseSlug: string, bindingId: number) => {
    assertSlug(caseSlug)
    return removeBinding(db, caseSlug, bindingId)
  })
  ipcMain.handle(IPC.prSearch, (_e, caseSlug: string) => {
    assertSlug(caseSlug)
    return searchPrsForCase({ db }, caseSlug)
  })
  ipcMain.handle(IPC.workspacesRefs, (_e, caseSlug: string) => {
    const cj = path.join(caseDir(argusHome, caseSlug), 'case.json')
    try {
      const data = JSON.parse(fs.readFileSync(cj, 'utf8')) as { workspaceRefs?: unknown }
      return Array.isArray(data.workspaceRefs) ? data.workspaceRefs : []
    } catch {
      return []
    }
  })
  ipcMain.handle(
    IPC.workspacesReadSnippet,
    (
      _e,
      caseSlug: string,
      repoName: string,
      relPath: string,
      start: number,
      end?: number,
      atSha?: string
    ) => {
      assertSlug(caseSlug)
      return readRepoSnippet(db, argusHome, caseSlug, repoName, relPath, start, end ?? start, atSha)
    }
  )
  ipcMain.handle(
    IPC.workspacesReadText,
    (_e, caseSlug: string, repoName: string, relPath: string, focusStart: number) => {
      assertSlug(caseSlug)
      return readRepoText(db, argusHome, caseSlug, repoName, relPath, focusStart)
    }
  )
  ipcMain.handle(IPC.graphBuild, (_e, repoPath: string, scope: string | null) =>
    codeGraph.build(repoPath, scope)
  )
  ipcMain.handle(IPC.graphStatus, (_e, repoPath: string) => codeGraph.status(repoPath))
  ipcMain.handle(IPC.graphInstall, () => codeGraph.installTool())

  // — case bundles (.arguscase) —
  ipcMain.handle(IPC.bundleExport, async (_e, caseSlug: string, includeTranscripts: boolean) => {
    const r = await dialog.showSaveDialog({
      defaultPath: `${caseSlug}.arguscase`,
      filters: [{ name: 'Argus case bundle', extensions: ['arguscase'] }]
    })
    if (r.canceled || !r.filePath) return null
    try {
      const manifest = await exportCase(
        db,
        argusHome,
        caseSlug,
        r.filePath,
        { includeTranscripts },
        { argusVersion: app.getVersion() }
      )
      return { ok: true as const, path: r.filePath, fileCount: manifest.files.length }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })
  ipcMain.handle(IPC.bundleInspect, async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Argus case bundle', extensions: ['arguscase'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    try {
      return { ok: true as const, inspection: await inspectBundle(db, argusHome, r.filePaths[0]) }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })
  ipcMain.handle(IPC.bundleImport, async (_e, zipPath: string, slug: string) => {
    try {
      return { ok: true as const, record: await importCase(db, argusHome, zipPath, slug) }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  // — files (case-dir explorer) —
  ipcMain.handle(IPC.filesList, (_e, slug: string) => {
    // Validate via listCaseFiles (unknown/invalid slugs throw) before a watcher
    // is ever started — an unknown or malicious slug must not leave one behind.
    const out = listCaseFiles(db, argusHome, slug)
    caseWatch.watch(slug)
    return out
  })
  ipcMain.handle(IPC.filesRead, (_e, slug: string, relPath: string) =>
    readCaseFile(argusHome, slug, relPath)
  )
  ipcMain.handle(IPC.filesOpen, (_e, slug: string, relPath: string) =>
    shell.openPath(resolveCasePath(argusHome, slug, relPath))
  )
  ipcMain.handle(IPC.filesReveal, (_e, slug: string, relPath?: string) => {
    if (relPath) shell.showItemInFolder(resolveCasePath(argusHome, slug, relPath))
    else {
      assertSlug(slug)
      void shell.openPath(caseDir(argusHome, slug))
    }
  })

  ipcMain.handle(IPC.casesDelete, async (_e, slug: string) => {
    assertSlug(slug)
    // strict order: live sessions → watcher → DB/audit/filesystem (in deleteCase)
    await agentService!.stopAllForCase(slug)
    caseWatch.unwatch(slug)
    deleteCase(db, argusHome, slug)
    panelHost?.closeCase(slug)
    externalAppHost?.closeCase(slug)
  })

  // — case-close distillation (part 3a) —
  ipcMain.handle(IPC.distillStatus, (_e, slug: string) => distillQueue.statusFor(slug))
  ipcMain.handle(IPC.distillNeedsRun, (_e, slug: string) => needsDistillRun(db, distillQueue, slug))
  ipcMain.handle(IPC.distillRetry, (_e, jobId: number) => distillQueue.retry(jobId))
  // Routed through reconcileAndEnqueue, not a bare enqueue() call: redistilling from the
  // case-actions menu can race a stale renderer row (see CaseAnchor's epoch guard) or a
  // swallowed broadcast, either of which could otherwise reach here for a slug that already has
  // an in-flight job — see reconcileAndEnqueue's doc comment in queue.ts. (The guard now lives
  // inside DistillQueue.enqueue() itself, so this call would be safe either way, but the named
  // wrapper documents the intent at this call site the same way it does at onCaseClosed.)
  ipcMain.handle(IPC.distillRedistill, (_e, slug: string) =>
    reconcileAndEnqueue(distillQueue, slug)
  )
  ipcMain.handle(IPC.distillCancel, (_e, jobId: number) => distillQueue.cancel(jobId))

  // — defect corpus —
  ipcMain.handle(IPC.defectsSearch, (_e, req: CorpusSearchInput) => defectCorpus.searchAll(req))
  ipcMain.handle(IPC.defectsTest, (_e, id: string) => defectCorpus.test(id))
  ipcMain.handle(IPC.defectsSyncNow, (_e, id: string) => defectCorpus.syncNow(id))
  ipcMain.handle(IPC.defectsSyncStatus, (_e, id: string) => defectCorpus.syncStatus(id))
  ipcMain.handle(IPC.defectsGetConfig, (_e, id: string) => defectCorpus.getConfig(id))
  ipcMain.handle(IPC.defectsPutConfig, (_e, id: string, cfg: CorpusAdminConfig) =>
    defectCorpus.putConfig(id, cfg)
  )
  ipcMain.handle(IPC.defectsJqlPreview, (_e, id: string, jql: string) =>
    defectCorpus.jqlPreview(id, jql)
  )

  // — unified related history —
  const relatedHistory = new RelatedHistoryService({
    db,
    defectCorpus,
    localCasesEnabled: () => settingsService.get().general.similarPastCasesEnabled
  })
  ipcMain.handle(IPC.relatedSearch, (_e, input: unknown) =>
    // IPC args are untrusted: one chokepoint validates and normalizes the whole
    // payload (slug, limit clamp, mode enum, filter shape) before it can reach a
    // SQL path or a corpus request body — see relatedHistory/input.ts.
    relatedHistory.search(validateRelatedSearchInput(input))
  )
  ipcMain.handle(IPC.relatedDefect, (_e, sourceId: string, key: string) => {
    // Same posture: an IPC arg is untrusted input, not a typed guarantee.
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new Error(`Invalid source id: ${JSON.stringify(sourceId)}`)
    }
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`Invalid defect key: ${JSON.stringify(key)}`)
    }
    return defectCorpus.getDefect(sourceId, key)
  })
  // No arguments to validate — a pure read of configured-source capabilities.
  ipcMain.handle(IPC.relatedSources, () => relatedHistory.sources())
  ipcMain.handle(
    IPC.relatedAttachEvidence,
    async (_e, caseSlug: string, sourceId: string, key: string) => {
      // Same posture as relatedDefect: an IPC arg is untrusted input. `key` gets a
      // second, stricter check inside attachCorpusEvidence, because it reaches a
      // filename there — this one only rejects the obviously malformed.
      assertSlug(caseSlug)
      if (typeof sourceId !== 'string' || sourceId.length === 0) {
        throw new Error(`Invalid source id: ${JSON.stringify(sourceId)}`)
      }
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error(`Invalid defect key: ${JSON.stringify(key)}`)
      }
      caseWatch.suppress(caseSlug) // our own write must not light the staleness dot
      const res = await attachCorpusEvidence(
        { db, argusHome, detection, queue: ingestQueue, defectCorpus },
        caseSlug,
        sourceId,
        key
      )
      // Refresh the case's evidence list only when something actually landed.
      if (res.ok && !res.deduped) evidenceChangedB(caseSlug)
      return res
    }
  )

  // — case RCA reports (part 3a-N) —
  ipcMain.handle(IPC.rcaGenerate, (_e, slug: string) => {
    assertSlug(slug)
    return rcaJobs.generate(slug)
  })
  ipcMain.handle(IPC.rcaStatus, (_e, slug: string) => rcaJobs.statusFor(slug))
  ipcMain.handle(
    IPC.rcaConfirm,
    (
      _e,
      slug: string,
      jobId: number,
      assignments: RoleAssignment[],
      edited: RcaDraft,
      dropped?: RcaDroppedSections
    ) => {
      // Validate BEFORE rcaJobs.confirm touches any state (role writes, artifact files) —
      // a malformed/stale renderer payload must never reach applyReportRoles. `dropped` needs
      // no gate of its own: `confirm` coerces each report's list with `toIdSet`, exactly as the
      // preview handler does, so a malformed value renders as "nothing dropped".
      const validated = validateRcaDraft(edited)
      return rcaJobs.confirm(slug, jobId, assignments, validated, dropped)
    }
  )
  ipcMain.handle(IPC.rcaPost, (_e, slug: string) =>
    postRcaReport(
      {
        db,
        argusHome,
        settings: () => settingsService.get(),
        callTool: (instanceId, name, args) => mcpService.callTool(instanceId, name, args),
        uploadAttachment: (key, filename, content) =>
          atlassian.uploadAttachment(key, filename, content),
        resolveRovoInstanceId: () => {
          const id = rovoInstanceId(connectorRegistry.get())
          if (!id)
            throw new AtlassianError(
              'not-configured',
              'No Atlassian connector configured — add the Atlassian Rovo preset in Settings → Connectors.'
            )
          return id
        },
        siteUrl: () => {
          const id = rovoInstanceId(connectorRegistry.get())
          return id ? atlassian.resolveSiteUrl(id) : Promise.resolve(null)
        }
      },
      slug
    )
  )
  // Pure render, no persistence: the panel calls this on every draft edit to keep the
  // Exec/Tech preview tabs live before the user confirms anything. Mirrors the meta shape
  // `RcaJobs.confirm` builds from `getCase` (see jobs.ts) — kept in sync by hand since this
  // is the one other call site that needs it.
  //
  // Renders under the newest job's SNAPSHOTTED template, matching what `confirm` will write.
  // Reading live settings here would make the preview disagree with the artifact whenever the
  // user edited the template after generating.
  //
  // `dropped` is keyed per report ({ exec?, tech? }), not shared. The default ids are globally
  // unique (`exec-impact` vs `tech-impact`), but nothing stops a user template from reusing an
  // id across the two lists, and a shared set would then strip a section from one report because
  // the user dropped its same-named counterpart in the other.
  ipcMain.handle(
    IPC.rcaRenderPreview,
    (_e, slug: string, edited: RcaDraft, dropped?: RcaDroppedSections) => {
      const validated = validateRcaDraft(edited)
      const kase = getCase(db, slug)
      if (!kase) throw new Error(`Unknown case: ${slug}`)
      const meta: CaseRcaInput['caseMeta'] = {
        slug: kase.slug,
        title: kase.title,
        jiraKey: kase.jiraKey,
        resolution: kase.resolution,
        tags: kase.tags,
        createdAt: kase.createdAt
      }
      const row = db
        .prepare(
          `SELECT template_snapshot FROM rca_jobs WHERE case_slug = ? ORDER BY id DESC LIMIT 1`
        )
        .get(slug) as { template_snapshot: string | null } | undefined
      const template = templateFromSnapshot(row?.template_snapshot)
      const execOpts = { template, dropped: toIdSet(dropped?.exec) }
      const techOpts = { template, dropped: toIdSet(dropped?.tech) }
      return {
        exec: renderExecReport(validated, meta, execOpts),
        tech: renderTechReport(validated, meta, techOpts)
      }
    }
  )
  ipcMain.handle(IPC.rcaReadMarkdown, (_e, slug: string) => {
    if (!getCase(db, slug)) throw new Error(`Unknown case: ${slug}`)
    return readReportMarkdown(argusHome, slug)
  })

  // `kind` is narrowed to the two literals before it reaches `artifacts.ts`, which maps them to
  // a closed set of filenames — no value from the renderer can name a path.
  ipcMain.handle(IPC.rcaSaveMarkdown, (_e, slug: string, kind: unknown, body: unknown) => {
    if (!getCase(db, slug)) throw new Error(`Unknown case: ${slug}`)
    if (kind !== 'exec' && kind !== 'tech') throw new Error(`invalid report kind: ${String(kind)}`)
    if (typeof body !== 'string') throw new Error('report body must be a string')
    writeReportMarkdown(argusHome, slug, kind, body)
  })

  ipcMain.handle(IPC.rcaHandEdited, (_e, slug: string) => {
    if (!getCase(db, slug)) throw new Error(`Unknown case: ${slug}`)
    return handEditedReports({ db, argusHome }, slug)
  })

  // — skills —
  const skillsPayload = (): SkillsPayload => ({
    skills: resolveSkills(argusHome, agentAccessStore.get()).map((s) => ({
      name: s.name,
      tier: s.tier,
      description: s.description,
      enabled: s.enabled,
      shadows: s.shadows,
      shadowDiverged:
        s.tier === 'user' && s.shadows.includes('hivemind')
          ? userSkillShadowDiverged(argusHome, s.name)
          : false,
      author: s.author
    }))
  })
  ipcMain.handle(IPC.skillsList, () => skillsPayload())
  ipcMain.handle(IPC.skillsDeleteUser, (_e, name: string) => {
    deleteUserSkill(argusHome, name)
    return skillsPayload()
  })
  ipcMain.handle(IPC.skillsRead, (_e, name: string) => readSkill(argusHome, name))
  ipcMain.handle(
    IPC.skillsWrite,
    async (_e, name: string, content: string, baseHash: string | null) => {
      const hash = writeUserSkill(argusHome, name, content, baseHash, await identity())
      const payload = skillsPayload()
      // the writer may be the editor window; every other window learns the list changed here
      broadcast(IPC.skillsChanged, payload)
      return { ...payload, hash }
    }
  )
  ipcMain.handle(IPC.skillsFork, async (_e, name: string, newName?: string) => {
    const created = forkSkill(argusHome, name, newName, await identity())
    const payload = skillsPayload()
    // Mirrors `skillsWrite` above, and `hivemindClaimReference`'s `refsyncChanged` below: a fork
    // changes the tier of a skill OTHER windows are showing, and the editor window decides
    // read-only from that tier. Without this the editor's tier map stays stale, so a
    // fork-in-place (the dialog's default — same name) leaves the user's own new copy mounted
    // READ-ONLY until the app restarts: they can make a copy and then cannot edit it.
    broadcast(IPC.skillsChanged, payload)
    return { name: created, skills: payload.skills }
  })
  ipcMain.handle(IPC.skillsImportScan, (_e, source: SkillImportSource) =>
    scanClaudeSkills(argusHome, source)
  )
  ipcMain.handle(IPC.skillsImportApply, async (_e, items: SkillImportItem[]) => {
    const results = importSkills(argusHome, items, await identity())
    const payload = skillsPayload()
    broadcast(IPC.skillsChanged, payload)
    return { results, payload }
  })

  // — authoring assist (skill/reference editor Draft + Improve) —
  ipcMain.handle(
    IPC.authoringDraft,
    async (_e, req: AuthoringRequest): Promise<AuthoringResult> => ({
      content: await draftAsset(req, headlessRun, resolvePrompt)
    })
  )
  ipcMain.handle(
    IPC.authoringImprove,
    async (_e, req: AuthoringRequest): Promise<AuthoringResult> => ({
      content: await improveAsset(req, headlessRun, resolvePrompt)
    })
  )

  // — editor window —
  ipcMain.handle(EDITOR_IPC.open, (_e, req: EditorOpenRequest) => {
    editorWindowService?.open(req)
  })
  ipcMain.on(EDITOR_IPC.dirtyState, (_e, count: number) => {
    editorWindowService?.setDirtyCount(count)
  })
  ipcMain.on(EDITOR_IPC.closeResponse, (_e, allow: boolean) => {
    editorWindowService?.resolveClose(allow)
  })
  ipcMain.on(EDITOR_IPC.draftChanged, (_e, change: DraftChange) => {
    draftStore?.queue(change)
  })
  ipcMain.handle(EDITOR_IPC.draftRead, (_e, ref: DraftRef) => draftStore?.read(ref) ?? null)
  ipcMain.handle(EDITOR_IPC.draftDiscard, (_e, ref: DraftRef) => {
    draftStore?.discard(ref)
  })
  ipcMain.handle(EDITOR_IPC.draftList, () => draftStore?.list() ?? [])
  ipcMain.handle(EDITOR_IPC.draftAdopt, (_e, req: DraftAdoptRequest) => {
    return draftStore?.adopt(req.legacy, req.change) ?? false
  })

  ipcMain.on(EDITOR_IPC.tabsChanged, (_e, tabs: PersistedTabs) => {
    pendingTabs = tabs
    if (tabsTimer) clearTimeout(tabsTimer)
    tabsTimer = setTimeout(() => flushTabs?.(), 1000)
  })

  ipcMain.handle(EDITOR_IPC.corpus, () => editorCorpus.list())
  ipcMain.handle(EDITOR_IPC.findReferences, (_e, req: FindReferencesRequest) =>
    editorCorpus.findReferences(req)
  )

  // — hivemind (spec §2.3) —
  const hivemind = new HivemindService({
    argusHome,
    repo: () => settingsService.get().hivemind.repo
  })
  ipcMain.handle(IPC.hivemindGet, () => hivemind.payload())
  ipcMain.handle(IPC.hivemindCheck, () => hivemind.check())
  ipcMain.handle(IPC.hivemindSync, () => hivemind.sync())
  ipcMain.handle(
    IPC.hivemindInstall,
    async (
      _e,
      kind: 'skill' | 'reference',
      name: string,
      opts?: { overwriteLocalEdits?: boolean }
    ) => {
      const p = await hivemind.install(kind, name, opts)
      if (kind === 'skill') {
        // install implies intent → clear any lingering disable override (sparse store keeps only false)
        agentAccessStore.patch({ skills: { [`hivemind/${name}`]: true } })
        broadcast(IPC.skillsChanged, skillsPayload())
      } else {
        // Downloading a reference writes into the references dir, exactly as uninstalling one
        // deletes from it — and the Library's list is a renderer-side mirror that fetches ONCE
        // and is only updated by this broadcast (referenceSyncStore.start() is idempotent). Its
        // absence is why a reference removed here and then re-downloaded never came back until
        // the window reloaded: the remove broadcast, the download did not.
        referencesChanged()
      }
      return p
    }
  )
  ipcMain.handle(IPC.hivemindUninstallSkill, async (_e, name: string) => {
    const p = await hivemind.uninstallSkill(name)
    // drop the enablement override entirely; a future re-install starts enabled again
    agentAccessStore.patch({ skills: { [`hivemind/${name}`]: null } })
    broadcast(IPC.skillsChanged, skillsPayload())
    return p
  })
  ipcMain.handle(IPC.hivemindUninstallReference, async (_e, name: string) => {
    const p = await hivemind.uninstallReference(name)
    referencesChanged()
    return p
  })
  ipcMain.handle(IPC.hivemindClaimReference, async (_e, name: string) => {
    const p = await hivemind.claimReference(name, await identity())
    referencesChanged()
    return p
  })
  ipcMain.handle(IPC.hivemindDiff, (_e, kind: 'skill' | 'reference', name: string) =>
    hivemind.diff(kind, name)
  )
  ipcMain.handle(IPC.hivemindLocalDivergence, (_e, name: string) => hivemind.localDivergence(name))
  ipcMain.handle(IPC.hivemindPushPreview, (_e, kind: 'skill' | 'reference', name: string) =>
    hivemind.pushPreview(kind, name)
  )
  ipcMain.handle(
    IPC.hivemindPush,
    async (_e, kind: 'skill' | 'reference', name: string, title: string) =>
      hivemind.push(kind, name, title, await identity())
  )
  ipcMain.handle(IPC.hivemindPushStatus, async (_e, kind: 'skill' | 'reference', name: string) =>
    hivemind.pushStatus(kind, name, await identity())
  )

  // — proposals (spec §2.4) —
  ipcMain.handle(IPC.proposalsList, () => ({ proposals: listProposals(argusHome) }))
  ipcMain.handle(IPC.proposalsAccept, async (_e, file: string, editedContent?: string) => {
    const accepted = acceptProposal(argusHome, file, {
      db,
      editedContent,
      identity: await identity()
    })
    // A reference-edit proposal WRITES a reference — it is how an agent's durable knowledge
    // gets into the library — but this handler never signalled it, so both the Library list and
    // INDEX.md stayed as they were until something else happened to fire.
    if (accepted.kind === 'reference') referencesChanged()
    return { proposals: listProposals(argusHome), accepted }
  })
  ipcMain.handle(IPC.proposalsReject, (_e, file: string, reason?: RejectReason) => {
    rejectProposal(argusHome, file, reason)
    return { proposals: listProposals(argusHome) }
  })
  const announceProposals = (): void => broadcast(IPC.proposalsChanged, proposalCounts(argusHome))
  setProposalsChangedNotifier(announceProposals)
  // Files dropped into proposals/ externally (manual seeding, external tools) never
  // route through the in-process notifier above, so badge/banners/page would go stale
  // until restart — watch the dir too. Using the same callback means an in-app write can
  // announce twice (notifier + watcher), but that's harmless: identical counts, and the
  // renderer coalesces naturally.
  // Not closed on quit: nothing in this file's shutdown path closes caseWatch either
  // (process exit tears down fs.watch handles), so this follows the existing convention.
  createProposalsWatch(argusHome, announceProposals)

  // — agent access + memory —
  ipcMain.handle(IPC.accessGet, () => agentAccessStore.payload())
  ipcMain.handle(IPC.accessPatch, (_e, p: unknown) => {
    agentAccessStore.patch(p)
    return agentAccessStore.payload()
  })
  ipcMain.handle(IPC.memoryTopics, () => memoryTopicsPayload())
  ipcMain.handle(IPC.memoryRead, (_e, name: string) => readTopic(argusHome, name))
  ipcMain.handle(IPC.memoryWrite, (_e, name: string, content: string) => {
    writeTopicFile(argusHome, name, content)
    return memoryTopicsPayload()
  })
  ipcMain.handle(IPC.memoryDelete, (_e, name: string) => {
    deleteTopic(argusHome, name)
    return memoryTopicsPayload()
  })
  ipcMain.handle(IPC.memoryAudit, () => readAudit(argusHome, 50))
  ipcMain.handle(IPC.memoryArchive, (_e, name: string) => {
    archiveTopic(argusHome, name)
    return memoryTopicsPayload()
  })
  ipcMain.handle(IPC.memoryRestore, (_e, name: string) => {
    restoreTopic(argusHome, name)
    return memoryTopicsPayload()
  })

  // — dev-only prompt surface —
  // Both handlers re-check the gate: the preload bridge is reachable from the devtools console
  // regardless of what the renderer chooses to render, so main must refuse rather than trust it.
  ipcMain.handle(IPC.devPromptsCatalog, (): PromptCatalogPayload => {
    assertDevTools(devTools)
    return promptStore.catalogPayload(Object.keys(MODES))
  })

  ipcMain.handle(IPC.devPromptsPreview, (_e, mode: string): PromptPreview => {
    assertDevTools(devTools)
    // `buildPromptPreview` validates the mode itself — IPC arguments are untyped at runtime, so
    // typecheck cannot police this boundary. Cast only after that guard exists.
    // Live inputs, so the preview reflects this install's packs and settings rather than
    // a synthetic default.
    return buildPromptPreview({
      mode: mode as ModeId,
      resolve: resolvePrompt,
      packFragments: packRegistry.personaFragments(),
      contributeBack: resolveSkills(argusHome, agentAccessStore.get()).some(
        (s) => s.name === 'contribute-back' && s.enabled
      ),
      personaAppend: settingsService.get().agent.personaAppend || undefined
    })
  })

  /** Every mutation returns the refreshed payload and announces the change, so the page and the
   *  Settings banner can never disagree about what is overridden. */
  const promptsChanged = (): PromptCatalogPayload => {
    broadcast(IPC.devPromptsChanged, promptStore.activeOverrideIds())
    return promptStore.catalogPayload(Object.keys(MODES))
  }

  ipcMain.handle(IPC.devPromptsSetOverride, (_e, id: string, text: string) => {
    assertDevTools(devTools)
    // The store validates id and editability itself — IPC arguments are untyped at runtime.
    promptStore.setOverride(id, text)
    return promptsChanged()
  })

  ipcMain.handle(IPC.devPromptsClearOverride, (_e, id: string) => {
    assertDevTools(devTools)
    promptStore.clearOverride(id)
    return promptsChanged()
  })

  ipcMain.handle(IPC.devPromptsClearAll, () => {
    assertDevTools(devTools)
    promptStore.clearAll()
    return promptsChanged()
  })

  ipcMain.handle(IPC.devPromptsOverrides, (): string[] => {
    assertDevTools(devTools)
    return promptStore.activeOverrideIds()
  })

  /** Resolve ONE entry for a renderer-owned prompt (the onboarding tour). Gated like every
   *  other dev-prompts handler; the caller falls back to its shipped constant on refusal,
   *  which is the normal path for anyone without the gate. */
  ipcMain.handle(IPC.devPromptsResolve, (_e, id: string): string => {
    assertDevTools(devTools)
    // The store rejects an unknown id itself — IPC arguments are untyped at runtime.
    return promptStore.resolve(id)
  })

  ipcMain.handle(IPC.devPromptsCaptures, (): PromptCaptureListPayload => {
    assertDevTools(devTools)
    return promptCaptures.list()
  })

  ipcMain.handle(
    IPC.devPromptsCapture,
    (_e, caseSlug: string, sessionId: number): PromptCaptureDetail | null => {
      assertDevTools(devTools)
      // The store validates the slug itself — IPC arguments are untyped at runtime.
      const capture = promptCaptures.read(caseSlug, Number(sessionId))
      if (!capture) return null
      return buildCaptureDetail({
        capture,
        // Live inputs, so "what a session would build now" means this install's packs and
        // settings — the same composition the Composed-preview tab shows.
        persona: () =>
          buildPromptPreview({
            mode: capture.mode as ModeId,
            resolve: resolvePrompt,
            packFragments: packRegistry.personaFragments(),
            contributeBack: resolveSkills(argusHome, agentAccessStore.get()).some(
              (s) => s.name === 'contribute-back' && s.enabled
            ),
            personaAppend: settingsService.get().agent.personaAppend || undefined
          }).text
      })
    }
  )

  /** Bundles each case's latest fully-reviewed distill job into an NDJSON eval corpus file.
   *  Gated like every dev-prompts handler; snapshots contain raw case data, so the write goes
   *  only where the user's save dialog points — nothing is uploaded. */
  ipcMain.handle(
    IPC.devPromptsExportDistillEval,
    async (): Promise<DistillEvalExportResult | null> => {
      assertDevTools(devTools)
      const r = await dialog.showSaveDialog({
        defaultPath: `distill-eval-${new Date().toISOString().slice(0, 10)}.ndjson`,
        filters: [{ name: 'NDJSON', extensions: ['ndjson'] }]
      })
      if (r.canceled || !r.filePath) return null
      return exportEvalBundle(db, argusHome, r.filePath, app.getVersion())
    }
  )

  // — settings —
  ipcMain.handle(IPC.settingsGet, () => settingsService.payload())
  ipcMain.handle(IPC.settingsPatch, (_e, p: unknown) => {
    settingsService.patch(p)
    return settingsService.payload()
  })
  ipcMain.handle(IPC.settingsProbeTools, () => binariesService.probe())
  ipcMain.handle(IPC.settingsPickPath, async (_e, mode: 'file' | 'directory') => {
    const r = await dialog.showOpenDialog({
      properties: [mode === 'file' ? 'openFile' : 'openDirectory']
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle(IPC.settingsReveal, (_e, what: 'dataRoot' | 'settingsFile') => {
    if (what === 'settingsFile') {
      const p = settingsPath(argusHome)
      if (fs.existsSync(p)) shell.showItemInFolder(p)
      else void shell.openPath(configDir(argusHome))
    } else void shell.openPath(argusHome)
  })
  ipcMain.handle(IPC.settingsSetDataRoot, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return { changed: false }
    writeRootOverride(userDataDir, r.filePaths[0])
    app.relaunch()
    app.exit(0)
    return { changed: true }
  })
  // Click-6-times-on-the-version unlock. `devTools` (closed over above) already reflects
  // whatever was true at boot, so this just reports it back — the marker this writes only
  // takes effect on the NEXT launch, same as ARGUS_DEV_TOOLS=1 does today.
  ipcMain.handle(IPC.devToolsUnlock, () => {
    if (!devTools) writeDevToolsUnlocked(argusHome)
    return { devTools }
  })

  // — connectors + secrets —
  ipcMain.handle(IPC.connectorsGet, () => connectorsPayload())
  ipcMain.handle(IPC.connectorsPatch, (_e, p: unknown) => {
    const before = Object.keys(connectorRegistry.get())
    connectorRegistry.patch(p)
    const after = new Set(Object.keys(connectorRegistry.get()))
    for (const id of before) {
      if (!after.has(id)) {
        mcpOauth.clear(id)
        atlassian.invalidateCloud(id)
        secretStore.deletePrefix(`connector/${id}/`)
      }
    }
    return connectorsPayload()
  })
  ipcMain.handle(IPC.connectorsTest, async (_e, id: string) => {
    const r = await mcpService.probe(id)
    broadcast(IPC.connectorsChanged, connectorsPayload())
    return r
  })
  ipcMain.handle(IPC.connectorsOauth, async (_e, id: string) => {
    const inst = connectorRegistry.get()[id]
    if (!inst) return { ok: false, error: `unknown connector: ${id}` }
    const cfg = connectorConfig<HttpConnectorConfig>('http', inst.config)
    atlassian.invalidateCloud(id)
    const r = await mcpOauth.authorize(id, cfg.url)
    // Reset the connector card's display badge (e.g. a stale needs-auth mark) after a
    // successful authorize. Display-only: compose() never consults runtime state, so
    // this has no effect on what the next session actually includes.
    if (r.ok) {
      mcpService.clearRuntime(id)
      // Only the rovo-preset connector has Atlassian REST behind it — resolveSiteUrl
      // otherwise resolves creds for a connector that was never registered with
      // resolveAtlassianCreds, and would cache Atlassian's site under the wrong id.
      if (inst.preset === 'rovo') void atlassian.resolveSiteUrl(id) // warm cloudId+siteUrl cache; ignore result/errors
    }
    broadcast(IPC.connectorsChanged, connectorsPayload())
    return r
  })
  ipcMain.handle(IPC.appOpenExternal, (_e, url: string) => {
    if (!isOpenableUrl(url)) return
    void shell.openExternal(url)
  })
  ipcMain.handle(IPC.secretsSet, (_e, name: string, value: string) => {
    secretStore.set(name, value) // throws when safeStorage is unavailable → renderer surfaces the message
  })
  ipcMain.handle(IPC.secretsHas, (_e, name: string) => secretStore.has(name))
  ipcMain.handle(IPC.secretsDelete, (_e, name: string) => {
    secretStore.delete(name)
  })

  // — health —
  const healthService = new HealthService({
    argusHome,
    binaries: () =>
      binariesService.all().map((r) => ({ id: r.decl.id, label: r.decl.displayName })),
    checkBinary: (id) => binariesService.healthCheck(id),
    agentAuth: async () => {
      const settings = settingsService.get()
      const { driver, unknownSlug } = resolveDriver(settings.agent)
      if (unknownSlug) {
        return { ok: false, verified: false, detail: `Unknown agent driver: ${unknownSlug}` }
      }
      const result = await driver.probeAuth({
        timeoutMs: settings.agent.probeTimeoutMs,
        cliPath: activeInstanceConfig(settings).cliPath
      })
      return { ...result, verified: false, fixHint: driver.authFixHint }
    },
    enabledConnectors: () =>
      Object.entries(connectorRegistry.get())
        .filter(([, i]) => i.enabled)
        .map(([id, i]) => ({ id, name: i.displayName?.trim() || id })),
    probeConnector: (id) => mcpService.probe(id),
    // REST is optional for MCP-only Rovo usage — the row appears only once REST
    // configuration has begun (siteUrl or token set), never as a failure before that.
    atlassianConfigured: () => atlassianRestConfigured(connectorRegistry.get(), mcpOauth),
    atlassianCheck: async () => {
      try {
        await atlassian.probeJira()
        return { ok: true, detail: 'Jira REST reachable' }
      } catch (err) {
        return { ok: false, detail: (err as Error).message }
      }
    },
    refsyncConfigured: () => refSyncStore.get().spaces.length > 0,
    confluenceCheck: async () => {
      const first = refSyncStore.get().spaces[0]
      if (!first) return { ok: false, detail: 'no Confluence space configured' }
      try {
        const s = await atlassian.getConfluenceSpace(first.key)
        return { ok: true, detail: `space ${s.key} (${s.name}) reachable` }
      } catch (err) {
        return { ok: false, detail: (err as Error).message }
      }
    },
    langfuseConfigured: () => {
      const s = settingsService.get().observability?.langfuse
      return Boolean(s?.enabled && s.host && s.publicKey)
    },
    langfuseCheck: async () => {
      const s = settingsService.get().observability?.langfuse
      return probeLangfuseCredentials({
        host: s?.host ?? '',
        publicKey: s?.publicKey ?? '',
        secretKey: secretStore.resolve('observability/langfuse/secret-key') ?? ''
      })
    }
  })

  ipcMain.handle(IPC.healthList, () => healthService.rows())
  ipcMain.handle(IPC.healthRun, async (_e, ids?: string[]) => {
    await healthService.run(ids ?? null, (r) => broadcast(IPC.healthResult, r))
  })
  ipcMain.handle(IPC.sourceControlStatus, () => ghStatus())

  ipcMain.handle(IPC.diagnosticsLatest, () => diagnostics?.latest() ?? null)
  ipcMain.handle(IPC.diagnosticsSubscribe, (e) => {
    const id = e.sender.id
    diagnostics?.subscribe(id)
    // Cleanup rides on the sender, not on any one window's close handler, so every
    // current and future window that can subscribe (editor, not just main) is covered.
    // Guard against wiring more than one listener set per webContents id: a renderer
    // can call subscribe() again over its lifetime (StrictMode double-invoke, repeated
    // navigation), and a naive listener-per-call would pile them up.
    if (!diagnosticsDestroyedWired.has(id)) {
      diagnosticsDestroyedWired.add(id)
      const sender = e.sender
      // A reload or renderer crash keeps the same webContents id, so 'destroyed' never
      // fires for either — React's unmount cleanup doesn't run, the id stays in the
      // subscriber set, and the service keeps sampling at 1Hz for a page nobody is
      // listening to. Cover all three ways a subscriber can go away, and remove every
      // listener + the wired-set entry together so a later subscribe() (post-reload)
      // re-arms cleanly instead of silently doing nothing.
      const onNavigate = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
        // Same-document navigations (hash changes, pushState) are not a page reload —
        // the React tree that called subscribe() is still mounted and listening.
        if (details.isMainFrame && !details.isSameDocument) cleanup()
      }
      const onRenderGone = (): void => cleanup()
      const onDestroyed = (): void => cleanup()
      function cleanup(): void {
        sender.off('destroyed', onDestroyed)
        sender.off('did-start-navigation', onNavigate)
        sender.off('render-process-gone', onRenderGone)
        diagnosticsDestroyedWired.delete(id)
        diagnostics?.unsubscribe(id)
      }
      sender.once('destroyed', onDestroyed)
      sender.on('did-start-navigation', onNavigate)
      sender.once('render-process-gone', onRenderGone)
    }
  })
  ipcMain.handle(IPC.diagnosticsUnsubscribe, (e) => {
    diagnostics?.unsubscribe(e.sender.id)
  })
  ipcMain.handle(IPC.diagnosticsRetrySidecar, () => {
    diagnostics?.retrySidecar()
  })
  ipcMain.handle(
    IPC.diagnosticsHistory,
    (_e, windowMs: number) => diagnostics?.history(windowMs) ?? null
  )
  ipcMain.handle(
    IPC.diagnosticsTerminate,
    async (_e, id: string): Promise<TerminateResult> =>
      (await diagnostics?.terminate(id)) ?? { ok: false, reason: 'gone' }
  )

  // — jira case lifecycle (Part 3) —
  // `jiraCases` itself is constructed further up, near the routines scope-resolver binding
  // (see the comment there) — it needs to exist before that binding, not before this comment.

  // Typed-result boundary: AtlassianError → { ok: false, code }, auth errors also
  // land on the connector card (payload.rest) + are cleared on the next success.
  const jiraResult = async <T>(fn: () => Promise<T>): Promise<JiraResult<T>> => {
    try {
      const value = await fn()
      if (Object.keys(restErrors).length) {
        // single Atlassian instance today; revisit per-instance clearing if a second lands
        for (const k of Object.keys(restErrors)) delete restErrors[k]
        broadcast(IPC.connectorsChanged, connectorsPayload())
      }
      return { ok: true, value }
    } catch (err) {
      if (err instanceof AtlassianError) {
        if (err.code === 'auth' && err.instanceId) {
          restErrors[err.instanceId] = err.message
          broadcast(IPC.connectorsChanged, connectorsPayload())
        }
        return { ok: false, code: err.code, message: err.message }
      }
      return { ok: false, code: 'internal', message: (err as Error).message }
    }
  }

  ipcMain.handle(IPC.jiraPreview, (_e, key: string) => jiraResult(() => jiraCases.preview(key)))
  ipcMain.handle(
    IPC.jiraCreateCase,
    async (_e, input: { slug: string; title: string; key: string }) => {
      const r = await jiraResult(() => jiraCases.createFromTicket(input))
      if (r.ok)
        await autoLinkDefaultRepo(
          db,
          argusHome,
          input.slug,
          settingsService.get().general.defaultRepos
        )
      return r
    }
  )
  ipcMain.handle(IPC.jiraIngestAttachments, (_e, caseSlug: string, atts: JiraAttachmentInfo[]) =>
    jiraResult(() => jiraCases.ingestAttachments(caseSlug, atts))
  )
  ipcMain.handle(IPC.jiraRefreshCase, (_e, caseSlug: string) =>
    jiraResult(() => jiraCases.refresh(caseSlug))
  )
  ipcMain.handle(IPC.jiraMarkReviewed, (_e, caseSlug: string) =>
    jiraResult(async () => jiraCases.markReviewed(caseSlug))
  )
  ipcMain.handle(IPC.jiraSyncAll, (e) =>
    jiraResult(() =>
      jiraCases.syncAll((done, total) => e.sender.send(IPC.jiraSyncProgress, { done, total }))
    )
  )
  ipcMain.handle(IPC.jiraSetAttachmentSelection, (_e, caseSlug: string, deselected: string[]) =>
    jiraResult(async () => setCaseJiraDeselected(db, argusHome, caseSlug, deselected.map(String)))
  )

  // Open the case's Jira issue in the system browser. URL construction stays in
  // main: siteUrl never crosses to the renderer and the http(s) guard applies.
  ipcMain.handle(IPC.jiraOpenIssue, async (_e, caseSlug: string) => {
    const kase = getCase(db, caseSlug)
    if (!kase?.jiraKey) return
    // siteUrl only, no creds: the browser opens the issue on the user's own
    // Atlassian session, so a missing API token must not block this. siteUrl
    // comes from the OAuth discovery cache (warmed on authorize / prior REST
    // calls) rather than a config field — degrade to a no-op when it's cold
    // or the rovo connector isn't authorized.
    const id = rovoInstanceId(connectorRegistry.get())
    const siteUrl = id ? await atlassian.resolveSiteUrl(id) : null
    if (!siteUrl) return // no connector / site URL — menu item is a no-op
    const url = jiraBrowseUrl(siteUrl, kase.jiraKey)
    if (!isOpenableUrl(url)) return
    void shell.openExternal(url)
  })

  // — reference sync handlers —
  ipcMain.handle(IPC.refsyncGet, () => refSync.payload())
  ipcMain.handle(IPC.refsyncValidateSpace, (_e, key: string) =>
    jiraResult(() => refSync.validateSpace(key))
  )
  ipcMain.handle(IPC.refsyncChildren, (_e, spaceKey: string, pageId: string) =>
    jiraResult(() => refSync.children(spaceKey, pageId))
  )
  ipcMain.handle(IPC.refsyncSaveSpace, (_e, space: unknown) => {
    refSync.saveSpace(space)
    return refSync.payload()
  })
  ipcMain.handle(IPC.refsyncRemoveSpace, (_e, key: string) => {
    refSync.removeSpace(key)
    return refSync.payload()
  })
  ipcMain.handle(IPC.refsyncSync, (_e, key: string) =>
    jiraResult(() =>
      refSync.sync(key, (m) => broadcast(IPC.refsyncProgress, { spaceKey: key, message: m }))
    )
  )
  ipcMain.handle(IPC.refsyncApplyDrafts, (_e, syncId: string, targets: string[]) => {
    const r = refSync.applyDrafts(syncId, targets)
    referencesChanged()
    return r
  })
  ipcMain.handle(IPC.refsyncPrune, (_e, syncId: string, targets: string[]) => {
    const r = refSync.prune(syncId, targets)
    referencesChanged()
    return r
  })
  ipcMain.handle(IPC.refsyncReadRef, (_e, file: string) => refSync.readReference(file))
  ipcMain.handle(
    IPC.refsyncWriteRef,
    async (_e, file: string, content: string, baseHash: string | null) => {
      const hash = refSync.writeReference(file, content, baseHash, await identity())
      referencesChanged()
      return hash
    }
  )
  ipcMain.handle(IPC.refsyncSearchRefs, (_e, query: string) => refSync.searchReferences(query))
  ipcMain.handle(IPC.refsyncDeleteRef, (_e, file: string) => {
    refSync.deleteReference(file)
    referencesChanged()
  })
}

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // keep the 3-pane case workspace comfortable at its own default rail widths, not just
    // legal at their clamps: evidence (320) + chat (560) + findings (384) + 2 separators (8)
    minWidth: 1280,
    minHeight: 800,
    show: false,
    autoHideMenuBar: true,
    ...mainWindowOptions(lastTheme, lastScale, icon, join(__dirname, '../preload/index.js'))
  })
  // Captured now rather than read from mainWindow inside 'closed' below: by the time that
  // handler runs, mainWindow has already been set to null (its first statement), and the
  // module-level binding's static type is BrowserWindow | null either way.
  const windowContentsId = mainWindow.webContents.id

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Both the OS and our own toggle can change this, so the renderer is told rather than
  // inferring it from its own click (double-click on the drag region and Windows snap gestures
  // never reach our handler).
  const sendMaximized = (maximized: boolean) => (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IPC.windowMaximizedChanged, maximized)
  }
  mainWindow.on('maximize', sendMaximized(true))
  mainWindow.on('unmaximize', sendMaximized(false))

  // macOS hides the traffic lights in full screen, so the header's left inset (which reserves
  // room for them) has to collapse. Told, not inferred: `env(titlebar-area-x)` is never published
  // on darwin, and the DOM's `fullscreenchange` fires only for the Fullscreen API — the green
  // button and ⌃⌘F are invisible to the renderer. Registered on every platform, since the
  // renderer's consumer is a CSS rule already scoped to darwin.
  const sendFullScreen = (full: boolean) => (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IPC.windowFullScreenChanged, full)
  }
  mainWindow.on('enter-full-screen', sendFullScreen(true))
  mainWindow.on('leave-full-screen', sendFullScreen(false))

  mainWindow.on('closed', () => {
    mainWindow = null
    // A focus request belongs to the window it was made for. Without this, a window destroyed
    // before it ever mounted (and so before it could consume the flag) leaves the request set,
    // and the NEXT window to open — including one opened from the dock or a second launch, which
    // never asked for the inbox — would consume it and navigate somewhere the user didn't ask to
    // go. Harmless only while App's default view is already Home; that is a coincidence, not a
    // guarantee, and this branch has twice been bitten by resting on it.
    pendingFocusInbox = false
    // A closed window that stays subscribed pins the service to the 1s fast tier forever
    // with nobody watching, since the subscriber set is keyed by webContents id.
    diagnostics?.unsubscribe(windowContentsId)
    // Flush first: forceClose() destroys the editor renderer, and everything it typed since the
    // last debounce lives in draftStore's pending map, not in the window.
    draftStore?.flushAll()
    flushTabs?.()
    // Spec §3.4: the editor is a dependent child, not a peer. Force-close — a confirm
    // prompt during teardown would be unanswerable, and the draft store above makes this
    // non-destructive. The service itself is not torn down: it is an app-lifetime singleton
    // (constructed in registerIpc(), not here) so it survives a macOS
    // close-all-windows/dock-reactivate cycle the same way panelHost does.
    editorWindowService?.forceClose()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isOpenableUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Raise the main window, creating it if it is gone.
 *
 * One function because four callers mean the same thing by it — macOS's `activate`, the tray icon
 * and its Open item, `second-instance`, and a clicked run-finished notification — and four ad-hoc
 * versions is how one of them ends up not un-minimizing.
 *
 * It targets the MAIN window specifically. `BrowserWindow.getAllWindows().length === 0` (what
 * `activate` used to test) is not a proxy for "the main window is open": the editor is a second
 * BrowserWindow, so with the editor up and the main window closed that test is false and the
 * window the user asked for never appears.
 *
 * Returns whether it had to create the window — callers that need to push something into the
 * renderer right after (see {@link showMainWindowAndFocusInbox}) cannot just send immediately in
 * that case: a fresh window's `webContents` has only just started loading.
 */
function showMainWindow(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return true
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return false
}

/**
 * One process per database.
 *
 * Before keep-alive this was theoretical — closing the window quit the app, so every launch was a
 * cold start. With the app resident in the tray and no window on screen, the natural thing to do
 * is double-click the icon again, and without this that starts a SECOND process: two schedulers
 * polling, two writers on one SQLite file, and the same routine firing twice.
 *
 * Taken only when ARGUS_HOME is unset. Electron keys the lock on `app.getPath('userData')`, which
 * ARGUS_HOME does not redirect (services/paths.ts resolves the Argus data dir only), so an
 * unconditional lock would refuse every isolated-home launch — the verify skill's and every
 * scripts/cdp-*.mjs gate's. That is not just a harness concession: the lock exists to keep two
 * processes off one database, and two instances on different homes share no database.
 */
const singleInstance = process.env.ARGUS_HOME ? true : app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  // The second launch's real request: show me the app I already have.
  app.on('second-instance', () => showMainWindow())
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Belt-and-suspenders for the losing instance: `app.quit()` above should exit before 'ready',
  // but if it does not, nothing below may run — the database must not be opened twice.
  if (!singleInstance) return

  // Packaged apps launched from Finder/Dock inherit the minimal launchd PATH; merge in
  // the login shell's PATH before anything spawns a child process (gh detection, drivers).
  await hydratePathFromLoginShell()

  // Packaged-build smoke check (npm run smoke:packaged): probe every driver, print the
  // verdicts, exit. Runs before any IPC/window setup so it never touches user state.
  if (process.argv.includes('--smoke-providers')) {
    const { checkDriverBinaries, runProviderSmoke } =
      await import('./services/agent/smokeProviders')
    // The gate: every bundled CLI must launch. No credentials required.
    const { ok, results } = checkDriverBinaries()
    for (const r of results) {
      console.log(`${r.launched ? 'LAUNCHED' : 'FAILED  '}  ${r.kind}: ${r.detail}`)
    }
    // Informational only: the auth probes exercise the full driver path, but their verdicts
    // depend on being logged in, so they must never decide the build's fate.
    console.log('--- auth probes (informational; not gating) ---')
    for (const r of (await runProviderSmoke()).results) {
      console.log(`  ${r.kind}: ${r.detail}`)
    }
    app.exit(ok ? 0 : 1)
    return
  }

  // Set app user model id for windows — match the installer appId so the running
  // app's taskbar button groups with the pinned shortcut and shows notifications
  // under the right identity.
  electronApp.setAppUserModelId('com.argus.core')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()

  createWindow()

  app.on('activate', function () {
    // macOS: clicking the dock icon with no window open should bring the app back. Delegated so
    // it also covers the editor-window case the old getAllWindows() test got wrong.
    showMainWindow()
  })
})

let quitting = false
app.on('before-quit', (event) => {
  // This handler re-enters once app.quit() is called below — the second entry
  // must fall straight through so quit actually proceeds.
  if (quitting) return
  quitting = true
  event.preventDefault()

  panelHost?.closeAll()
  externalAppHost?.closeAll()
  // Belt-and-suspenders: the sidecar also exits on stdin EOF once this process dies,
  // but that leaves cleanup entirely implicit. Say so explicitly, and do it before
  // retry() could possibly race it (see SidecarClient.retry()'s 'disabled' guard).
  diagnostics?.stop()
  // Cmd+Q / app.quit() with the editor still open: the main-window path above never ran, so
  // this is the only flush that happens. Synchronous by design — nothing here can await.
  draftStore?.flushAll()
  flushTabs?.()
  editorWindowService?.forceClose()
  void agentService?.stopAll()
  // Before the scheduler stop below is fine either way, but it must happen: an undestroyed Tray
  // keeps the process alive after quit on Windows.
  trayService?.destroy()
  // Before routineStore.close() below: the tick reads the store, and a tick landing on a closed
  // watcher is a needless error on the quit path.
  routineScheduler?.stop()
  // `agentService?.stopAll()` two lines up does NOT reach this: a routine's background session
  // never enters AgentService's map (registry.ts), so it keeps executing, unattended, straight
  // through quit unless told otherwise here. This actually interrupts the live turn's driver —
  // the same session.stop() a turn's own timeout already uses — it does not merely relabel a
  // database row (a stranded `running` row is not user-visible either way: the startup backstop
  // reconciles it before any renderer could ever see it). See RoutinesService's own docblock for
  // why this stays synchronous and never awaits the teardown it starts.
  routinesServiceHandle?.stopForQuit()
  // Holds an fs watcher on config/routines.json. Unlike caseWatch/proposals (which the exit
  // path deliberately leaves to process teardown), this one also drops the subscriber that
  // broadcasts to windows — and windows are being torn down right now.
  routineStore?.close()

  // shutdown() (not flush()) — it also calls provider.shutdown(), which was never
  // reached on the quit path before. Race it against a hard timeout: a quit hang
  // is worse than losing telemetry, so a hung network call must never block quit.
  const shutdown = langfuseExporter?.shutdown() ?? Promise.resolve()
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3000)
    t.unref?.()
  })
  void Promise.race([shutdown, timeout]).finally(() => app.quit())
})

/** Reads through the live settings service — the user can flip the toggle mid-session. */
function keepAliveEnabled(): boolean {
  return appSettings?.get().general.keepAliveInBackground ?? false
}

// Quit when all windows are closed, except on macOS (where it's common for applications and
// their menu bar to stay active until the user quits explicitly with Cmd + Q), or when the
// keep-alive-in-background setting is on.
app.on('window-all-closed', () => {
  // macOS never quits here and never did — see services/keepAlive.ts for why that is the rule
  // rather than an exception. On Windows and Linux the setting decides, and with it off this
  // behaves exactly as it did before: quit, and let increment 2's catch-up fire the overdue
  // routine once on the next launch.
  if (shouldKeepAlive({ platform: process.platform, keepAlive: keepAliveEnabled() })) {
    // Only where keep-alive is what kept it — on macOS the app always survives this, so a notice
    // there would be announcing the platform's own behaviour as if Argus had invented it.
    if (process.platform !== 'darwin' && keepAliveEnabled()) notifyStillRunning()
    return
  }
  app.quit()
})

/**
 * Told once per install, the first time a close does not close.
 *
 * Delivered as a Notification rather than `Tray.displayBalloon`, which exists only on Windows —
 * the same surprise happens on Linux. Without it, the honest user report is "the app will not
 * quit", and the feature reads as a bug.
 */
function notifyStillRunning(): void {
  const settings = appSettings
  if (!settings || settings.get().general.keepAliveNoticeShown) return
  // Persisted BEFORE the notice is shown, not after. SettingsService.patch is synchronous and
  // writes to disk; if that write throws, showing the notice anyway would mean re-showing it on
  // every close forever. Bail instead — an unshown notice is a smaller failure than a nagging one.
  try {
    settings.patch({ general: { keepAliveNoticeShown: true } })
  } catch (err) {
    console.error('[routines] keep-alive notice flag write failed:', err)
    return
  }
  if (!Notification.isSupported()) return
  new Notification({
    title: 'Argus is still running',
    body: 'Scheduled routines keep firing in the background. Quit from the tray icon to stop.'
  }).show()
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
