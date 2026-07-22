import { app, shell, BrowserWindow, ipcMain, dialog, safeStorage, protocol } from 'electron'
import fs from 'node:fs'
import path, { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/argus-icon.png?asset'
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
  MEMORY_INDEX_MAX_LINES
} from './services/memory'
import { archiveTopic, restoreTopic } from './services/memoryHygiene'
import { deleteUserSkill, resolveSkills } from './services/agent/skillsResolver'
import { HivemindService } from './services/hivemind'
import { listProposals, acceptProposal, rejectProposal } from './services/proposals'
import type { MemoryTopicsPayload, SkillsPayload } from '../shared/memoryIpc'
import { loadPresets, isOpenableUrl } from './services/presets'
import { McpService } from './services/mcp'
import { McpOAuth } from './services/oauth'
import { HealthService } from './services/health'
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
  getCase
} from './services/caseService'
import { OnboardingService, resolveSampleAssetsDir } from './services/onboarding'
import { ingestArtifact, ingestBytes, listEvidence, deleteEvidence } from './services/ingest'
import { extractDerivedText } from './services/extraction'
import { listCaseFiles, readCaseFile, resolveCasePath, assertSlug } from './services/caseFiles'
import { createCaseWatchHub } from './services/caseWatch'
import { scanEvidence } from './services/scan'
import { searchEvidence, readEvidenceText, readEvidenceSnippet } from './services/search'
import { openTextDoc, readTextDocLines } from './services/textdoc'
import { TextDocSearchHub, type TextDocSearchOpts } from './services/textdocSearch'
import type { TextDocSource } from '../shared/textdoc'
import { searchMessages, searchAllMessages } from './services/chatSearch'
import { AgentService } from './services/agent/registry'
import { flattenPanelCommands } from './services/agent/panelCommands'
import {
  listSessions,
  createSession,
  setSessionModel,
  renameSession,
  deleteSession
} from './services/agent/sessionStore'
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
import { readRepoSnippet, readRepoText } from './services/workspaceRead'
import { exportCase, importCase, inspectBundle } from './services/bundle'
import { activeInstanceConfig, defaultModelRef } from '../shared/drivers'
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
import { PanelHost } from './services/panels/panelHost'
import { createElectronPanelFactory } from './services/panels/electronPlatform'
import { resolvePanelAsset, buildPanelCsp, type PanelWindowLoc } from './services/panels/protocol'
import { ExternalAppHost } from './services/panels/externalAppHost'
import { createElectronProcessSpawner } from './services/panels/electronProcessSpawner'
import type { OpenPanelRequest, PanelKey, PanelPermission, PanelRect } from '../shared/panels'
import type {
  ApprovalDecision,
  CaseRecord,
  CaseResolution,
  CaseStatus,
  DialogAnswer,
  NewCaseInput,
  SearchFilters,
  UnifiedHit
} from '../shared/types'
import { globalMetrics, caseMetrics } from './services/observability/metrics'
import { LangfuseExporter } from './services/observability/langfuse'
import { LangfuseSink } from './services/observability/langfuseSink'
import { createLangfuseTracing } from './services/observability/langfuseTracing'
import { probeLangfuseCredentials } from './services/observability/langfuseProbe'
import { usageStats, ensureTrackingStarted } from './services/observability/usage'
import { listFindings, reviewFinding, clearFindings } from './services/findings'
import type { MetricsQuery, ReviewState } from '../shared/observability'
import { DistillQueue } from './services/distill/queue'
import { assembleDistillInput } from './services/distill/input'
import { runCaseDistill } from './services/distill/caseDistiller'
import { stageDistillOutput } from './services/distill/staging'
import { similarCases, searchCaseSummaries } from './services/distill/summaries'

let agentService: AgentService | null = null
let providerStatusService: ProviderStatusService | null = null
let langfuseExporter: LangfuseExporter | null = null
let mainWindow: BrowserWindow | null = null
let panelHost: PanelHost | null = null
let externalAppHost: ExternalAppHost | null = null

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
    onChange: () => broadcast(IPC.panelsChanged, undefined)
  })

  const packsState = new PacksStateStore(argusHome)
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
  const settingsService = new SettingsService(argusHome, {
    resolvedTools: () => binariesService.settingsRows()
  })

  // Usage-stats epoch: stamped once; anchors the memory-hygiene grace period (spec §2).
  ensureTrackingStarted(settingsService)

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
    broadcast
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

  const secretStore = new SecretStore(argusHome, safeStorage)

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
  const toolRiskStore = new ToolRiskStore(argusHome)
  const agentAccessStore = new AgentAccessStore(argusHome)
  const refSyncStore = new ReferenceSyncStore(argusHome)
  const connectorPresets = loadPresets(argusHome)
  const mcpOauth = new McpOAuth(secretStore, (url) => shell.openExternal(url))
  const mcpService = new McpService({
    registry: connectorRegistry,
    secrets: secretStore,
    toolRisk: () => toolRiskStore.get(),
    oauth: mcpOauth
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
    run: headlessRun
  })
  refSyncStore.subscribe(() => broadcast(IPC.refsyncChanged, refSync.payload()))

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
  const distillQueue = new DistillQueue({
    db,
    assembleInput: (slug) => assembleDistillInput(db, argusHome, slug, skillsIndexForDistill()),
    distill: (input) => runCaseDistill(input, headlessRun),
    stage: (slug, jobId, output) => stageDistillOutput(db, argusHome, slug, jobId, output),
    broadcast: (p) => broadcast(IPC.distillChanged, p)
  })
  distillQueue.recoverOnBoot()
  const onCaseClosed = (rec: CaseRecord): void => {
    try {
      distillQueue.enqueue(rec.slug)
    } catch (err) {
      console.error('[distill] enqueue failed', err)
    }
  }

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
      capLines: MEMORY_INDEX_MAX_LINES
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

  // Per-instance provider status for the settings page (every enabled provider at once),
  // as opposed to authCache's single default-provider verdict.
  const latestNpmVersion = createNpmVersionLookup()
  providerStatusService = new ProviderStatusService({
    settings: () => settingsService.get().agent,
    driverFor: (instanceId) =>
      resolveInstanceDriver(settingsService.get().agent, instanceId).driver,
    notify: () => broadcast(IPC.providersChanged, undefined),
    latestVersion: async (driverKind) => {
      const pkg = getDriverByKind(driverKind).npmPackage
      return pkg ? latestNpmVersion(pkg) : null
    }
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
    const rec = createCase(db, argusHome, input)
    await autoLinkDefaultRepo(db, argusHome, rec.slug, settingsService.get().general.defaultRepo)
    return rec
  })
  const sampleAssetsDir = resolveSampleAssetsDir(app.getAppPath(), resourcesPath)
  const onboardingService = new OnboardingService({
    db,
    argusHome,
    detection,
    sampleAssetsDir,
    listCaseSlugs: () => listCases(db).map((c) => c.slug)
  })
  ipcMain.handle(IPC.onboardingSeedSample, () => onboardingService.seedSampleCase())
  ipcMain.handle(IPC.casesList, () => listCases(db))
  ipcMain.handle(
    IPC.casesSetStatus,
    (_e, slug: string, status: CaseStatus, resolution: CaseResolution | null) =>
      setCaseStatus(db, argusHome, slug, status, resolution, onCaseClosed)
  )
  ipcMain.handle(IPC.evidenceIngest, (_e, caseSlug: string, absPaths: string[]) => {
    caseWatch.suppress(caseSlug) // pre-write: our own copies must not light the staleness dot
    const records = absPaths.map((p) => ingestArtifact(db, argusHome, detection, caseSlug, p))
    // fire-and-forget: derived text appears via evidence:changed when ready
    for (const rec of records) {
      broadcast(IPC.evidenceParsing, { slug: caseSlug, evidenceId: rec.id, active: true })
      // extractDerivedText CAN reject (its sync setup — db lookup, mkdirSync — runs
      // outside its internal try/catch); swallow the fire-and-forget rejection explicitly.
      void extractDerivedText(db, argusHome, rec, extractors)
        .then((derived) => {
          if (derived) evidenceChangedB(caseSlug)
        })
        .catch((err) =>
          console.warn(`[ingest] extraction failed for ${rec.relPath}: ${(err as Error).message}`)
        )
        .finally(() =>
          broadcast(IPC.evidenceParsing, { slug: caseSlug, evidenceId: rec.id, active: false })
        )
    }
    // re-arm after the sync copies: a multi-GB drop can outlive the first window
    caseWatch.suppress(caseSlug)
    return records
  })
  ipcMain.handle(
    IPC.evidenceIngestContent,
    (_e, caseSlug: string, fileName: string, bytes: Uint8Array) => {
      assertSlug(caseSlug)
      caseWatch.suppress(caseSlug) // our own write must not light the staleness dot
      const { record, deduped } = ingestBytes(
        db,
        argusHome,
        detection,
        caseSlug,
        path.basename(fileName), // defence in depth: no traversal out of evidence/
        Buffer.from(bytes),
        'paste'
      )
      if (!deduped) {
        broadcast(IPC.evidenceParsing, { slug: caseSlug, evidenceId: record.id, active: true })
        void extractDerivedText(db, argusHome, record, extractors)
          .then((derived) => {
            if (derived) evidenceChangedB(caseSlug)
          })
          .catch((err) =>
            console.warn(
              `[paste] extraction failed for ${record.relPath}: ${(err as Error).message}`
            )
          )
          .finally(() =>
            broadcast(IPC.evidenceParsing, { slug: caseSlug, evidenceId: record.id, active: false })
          )
      }
      // no re-arm suppress() here: evidenceChangedB() below already suppresses
      // internally, and suppress() is monotonic — a second call here is a no-op
      evidenceChangedB(caseSlug)
      return { record, deduped }
    }
  )
  ipcMain.handle(IPC.evidenceList, (_e, caseSlug: string) => {
    // start the staleness watcher on first listing; unknown slugs stay unwatched
    if (getCase(db, caseSlug)) caseWatch.watch(caseSlug)
    return listEvidence(db, caseSlug)
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
    const r = deleteEvidence(db, argusHome, caseSlug, evidenceId)
    evidenceChangedB(caseSlug)
    return r
  })
  ipcMain.handle(IPC.evidenceScan, (_e, caseSlug: string) => {
    assertSlug(caseSlug)
    caseWatch.suppress(caseSlug, 5000) // hashing a large folder outlives the default window
    return scanEvidence(
      db,
      argusHome,
      detection,
      extractors,
      {
        evidenceChanged: evidenceChangedB,
        parsing: (slug, id, active) =>
          broadcast(IPC.evidenceParsing, { slug, evidenceId: id, active })
      },
      caseSlug
    )
  })
  ipcMain.handle(IPC.searchQuery, (_e, q: string, filters?: SearchFilters) => {
    const f = filters ?? {}
    const sources = f.sources ?? ['evidence']
    const hits: UnifiedHit[] = []
    if (sources.includes('evidence'))
      hits.push(...searchEvidence(db, q, f).map((h) => ({ kind: 'evidence' as const, ...h })))
    if (sources.includes('chat')) hits.push(...searchAllMessages(db, q, f.caseSlug))
    if (sources.includes('summaries'))
      hits.push(
        ...searchCaseSummaries(db, q, { limit: 5 }).map((h) => ({ kind: 'summary' as const, ...h }))
      )
    return hits
  })
  ipcMain.handle(IPC.chatSearch, (_e, caseSlug: string, q: string) =>
    searchMessages(db, caseSlug, q)
  )
  // 1d: renderer artifact type/analyze-skill metadata sourced from pack detectors + generics.
  ipcMain.handle(IPC.packsArtifactMeta, () => detection.artifactMeta())
  // 1e: reference-sync routing seeds sourced from pack manifests.
  ipcMain.handle(IPC.packsReferenceRouting, () => packRegistry.referenceRouting())

  // — packs (install/uninstall/list; 2c) —
  ipcMain.handle(IPC.packsList, () =>
    listInstalledPacks({ state: packsState, registry: packRegistry, binaries: binariesService })
  )
  ipcMain.handle(IPC.packsPickBundle, async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Argus pack bundle', extensions: ['zip'] }]
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle(IPC.packsInspect, (_e, source: string) => inspectBundleSource(source))
  ipcMain.handle(IPC.packsInstall, async (_e, source: string) => {
    const res = await installPack(source, { argusHome, state: packsState })
    if (res.ok) broadcast(IPC.packsChanged, undefined)
    return res
  })
  ipcMain.handle(IPC.packsUninstall, (_e, id: string) => {
    const res = uninstallPack(id, { argusHome, state: packsState, coreSkillsDir })
    if (res.ok) broadcast(IPC.packsChanged, undefined)
    return res
  })
  ipcMain.handle(IPC.packsRelaunch, () => {
    app.relaunch()
    app.quit()
  })

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
    windowId: string
  ): Promise<CapturePanelEvidence> => {
    caseWatch.suppress(caseSlug) // pre-write: capture writes a screenshot into evidence/
    return capturePanelToEvidence(
      { panelHost: panelHost!, db, argusHome, detection },
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
  ipcMain.handle(IPC.panelsSetTheme, (_e, theme: 'dark' | 'light') => panelHost!.setTheme(theme))
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
  ipcMain.on(
    IPC.panelsCommandResult,
    (_e, p: { requestId: string; ok: boolean; result?: unknown; error?: string }) =>
      panelHost!.resolveCommand(p.requestId, p)
  )

  // — agent —
  agentService = new AgentService({
    db,
    argusHome,
    detection,
    skillsRoots: [
      sharedSkillsDir(argusHome),
      sharedReferencesDir(argusHome),
      graphsRoot(argusHome)
    ],
    personaFragments: () => packRegistry.personaFragments(),
    packCliNames: () => packRegistry.binaryDecls().flatMap(({ decl }) => decl.names),
    onEvent: (e) => {
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
    openPanel: openPanelFor,
    capturePanel: capturePanelFor,
    panelCommandDecls: () => flattenPanelCommands(packRegistry.windowDecls()),
    onCaseClosed,
    onWorktreeChanged: (slug) => broadcast(IPC.workspacesChanged, slug),
    dispatchPanelCommand: (caseSlug, packId, windowId, cmd, args) => {
      const w = panelWindow(packId, windowId)
      return w?.decl.kind === 'externalApp'
        ? externalAppHost!.dispatchToProcess({ caseSlug, packId, windowId }, cmd, args)
        : panelHost!.dispatchToPanel({ caseSlug, packId, windowId }, cmd, args)
    },
    mirrorFactory: (caseSlug, sessionId) =>
      new SessionMirror(
        db,
        path.join(caseDir(argusHome, caseSlug), 'sessions', `${sessionId}.jsonl`),
        {
          caseId: listCases(db).find((c) => c.slug === caseSlug)?.id ?? 0,
          sessionId
        }
      )
  })
  ipcMain.handle(IPC.agentSend, (_e, caseSlug: string, sessionId: number, text: string) => {
    return agentService!.send(caseSlug, sessionId, text)
  })
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
    await providerStatusService?.refreshAll()
    return providerStatusService?.list() ?? []
  })
  ipcMain.handle(IPC.agentPreflight, () => binariesService.preflight())
  ipcMain.handle(IPC.agentHistory, (_e, caseSlug: string, sessionId: number) => {
    assertSlug(caseSlug)
    if (!Number.isInteger(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
    return readSessionEvents(caseDir(argusHome, caseSlug), sessionId)
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
    listSessions(db, caseSlug, newSessionProvider())
  )
  ipcMain.handle(IPC.sessionsCreate, (_e, caseSlug: string) =>
    createSession(db, caseSlug, newSessionProvider())
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
      const changed = setSessionModel(db, sessionId, {
        driverKind: resolveInstanceDriver(settings.agent, instanceId).driver.kind,
        instanceId,
        model
      })
      // The live CaseSession has the old model frozen at query() construction; AgentService
      // compares modelKey on the next send and rebuilds. Nothing to do here.
      return changed
    }
  )
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
  ipcMain.handle(IPC.findingsClear, (_e, caseSlug: string) => {
    assertSlug(caseSlug)
    return clearFindings(db, argusHome, caseSlug)
  })

  // — workspaces —
  ipcMain.handle(IPC.workspacesPick, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle(IPC.workspacesLink, (_e, caseSlug: string, repoPath: string) =>
    linkWorkspace(db, argusHome, caseSlug, repoPath)
  )
  ipcMain.handle(IPC.workspacesUnlink, (_e, caseSlug: string, repoPath: string) =>
    unlinkWorkspace(db, argusHome, caseSlug, repoPath)
  )
  ipcMain.handle(IPC.workspacesList, (_e, caseSlug: string) =>
    listWorkspaces(db, argusHome, caseSlug)
  )
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
    (_e, caseSlug: string, repoName: string, relPath: string, start: number, end?: number) => {
      assertSlug(caseSlug)
      return readRepoSnippet(db, argusHome, caseSlug, repoName, relPath, start, end ?? start)
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
  ipcMain.handle(IPC.distillRetry, (_e, jobId: number) => distillQueue.retry(jobId))
  ipcMain.handle(IPC.distillRedistill, (_e, slug: string) => distillQueue.enqueue(slug))
  ipcMain.handle(IPC.distillSimilar, (_e, slug: string) => similarCases(db, slug))

  // — skills —
  const skillsPayload = (): SkillsPayload => ({
    skills: resolveSkills(argusHome, agentAccessStore.get()).map((s) => ({
      name: s.name,
      tier: s.tier,
      description: s.description,
      enabled: s.enabled,
      shadows: s.shadows
    }))
  })
  ipcMain.handle(IPC.skillsList, () => skillsPayload())
  ipcMain.handle(IPC.skillsDeleteUser, (_e, name: string) => {
    deleteUserSkill(argusHome, name)
    return skillsPayload()
  })

  // — hivemind (spec §2.3) —
  const hivemind = new HivemindService({
    argusHome,
    repo: () => settingsService.get().hivemind.repo
  })
  ipcMain.handle(IPC.hivemindGet, () => hivemind.payload())
  ipcMain.handle(IPC.hivemindCheck, () => hivemind.check())
  ipcMain.handle(IPC.hivemindSync, () => hivemind.sync())
  ipcMain.handle(IPC.hivemindInstall, async (_e, kind: 'skill' | 'reference', name: string) => {
    const p = await hivemind.install(kind, name)
    // install implies intent → clear any lingering disable override (sparse store keeps only false)
    if (kind === 'skill') agentAccessStore.patch({ skills: { [`hivemind/${name}`]: true } })
    return p
  })
  ipcMain.handle(IPC.hivemindUninstallSkill, async (_e, name: string) => {
    const p = await hivemind.uninstallSkill(name)
    // drop the enablement override entirely; a future re-install starts enabled again
    agentAccessStore.patch({ skills: { [`hivemind/${name}`]: null } })
    return p
  })
  ipcMain.handle(IPC.hivemindUninstallReference, (_e, name: string) =>
    hivemind.uninstallReference(name)
  )
  ipcMain.handle(IPC.hivemindClaimReference, (_e, name: string) => hivemind.claimReference(name))
  ipcMain.handle(IPC.hivemindDiff, (_e, kind: 'skill' | 'reference', name: string) =>
    hivemind.diff(kind, name)
  )
  ipcMain.handle(IPC.hivemindPushPreview, (_e, kind: 'skill' | 'reference', name: string) =>
    hivemind.pushPreview(kind, name)
  )
  ipcMain.handle(IPC.hivemindPush, (_e, kind: 'skill' | 'reference', name: string, title: string) =>
    hivemind.push(kind, name, title)
  )

  // — proposals (spec §2.4) —
  ipcMain.handle(IPC.proposalsList, () => ({ proposals: listProposals(argusHome) }))
  ipcMain.handle(IPC.proposalsAccept, (_e, file: string, editedContent?: string) => {
    acceptProposal(argusHome, file, { db, editedContent })
    return { proposals: listProposals(argusHome) }
  })
  ipcMain.handle(IPC.proposalsReject, (_e, file: string) => {
    rejectProposal(argusHome, file)
    return { proposals: listProposals(argusHome) }
  })

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

  // — jira case lifecycle (Part 3) —
  const jiraCases = new JiraCases({
    db,
    argusHome,
    detection,
    client: atlassian,
    // Read only after a successful client call (getIssue) already warmed the
    // discovery cache for this instance, so the sync cache read is safe here —
    // resolveSiteUrl's async discovery path is not needed on this hot path.
    site: () => atlassian.cachedSiteUrl(rovoInstanceId(connectorRegistry.get()) ?? '') ?? '',
    extractors,
    emitProgress: (p) => broadcast(IPC.jiraAttachmentProgress, p),
    evidenceChanged: evidenceChangedB,
    parsing: (slug, id, active) => broadcast(IPC.evidenceParsing, { slug, evidenceId: id, active })
  })

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
          settingsService.get().general.defaultRepo
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
    broadcast(IPC.refsyncChanged, refSync.payload())
    return r
  })
  ipcMain.handle(IPC.refsyncPrune, (_e, syncId: string, targets: string[]) => {
    const r = refSync.prune(syncId, targets)
    broadcast(IPC.refsyncChanged, refSync.payload())
    return r
  })
  ipcMain.handle(IPC.refsyncReadRef, (_e, file: string) => refSync.readReference(file))
  ipcMain.handle(IPC.refsyncSearchRefs, (_e, query: string) => refSync.searchReferences(query))
}

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    // keep the 3-pane case workspace usable: sidebar (320) + chat + findings rail
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
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

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Packaged-build smoke check (npm run smoke:packaged): probe every driver, print the
  // verdicts, exit. Runs before any IPC/window setup so it never touches user state.
  if (process.argv.includes('--smoke-providers')) {
    const { checkDriverBinaries, runProviderSmoke } = await import(
      './services/agent/smokeProviders'
    )
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
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
  void agentService?.stopAll()

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

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
