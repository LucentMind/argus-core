import { app, shell, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron'
import fs from 'node:fs'
import path, { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC } from '../shared/ipc'
import { resolveArgusHome, dbPath, caseDir, settingsPath, configDir } from './services/paths'
import { openDb } from './services/db'
import { SettingsService } from './services/settings'
import { SecretStore } from './services/secrets'
import { ConnectorRegistry } from './services/connectors'
import { ToolRiskStore } from './services/toolRisk'
import { loadPresets, isOpenableUrl } from './services/presets'
import { McpService } from './services/mcp'
import { McpOAuth } from './services/oauth'
import { HealthService } from './services/health'
import { ghStatus } from './services/sourceControl'
import {
  connectorConfig,
  type ConnectorsPayload,
  type HttpConnectorConfig
} from '../shared/connectors'
import { createCase, listCases } from './services/caseService'
import { ingestArtifact, listEvidence } from './services/ingest'
import { extractDerivedText } from './services/extraction'
import { searchEvidence, readEvidenceText } from './services/search'
import { AgentService } from './services/agent/registry'
import { SessionMirror, readSessionEvents } from './services/agent/mirror'
import { probeAuth } from './services/agent/probe'
import { runPreflight, ensureTraceOnPath } from './services/agent/preflight'
import { resolveArgusParse } from './services/parsers'
import { linkWorkspace, unlinkWorkspace, listWorkspaces } from './services/workspaces'
import { activeInstanceConfig } from '../shared/drivers'
import {
  seedSharedDirs,
  resolveAssetSource,
  listSkills,
  sharedSkillsDir,
  sharedReferencesDir
} from './services/skillsDir'
import type { ApprovalDecision, AuthStatus, NewCaseInput, SearchFilters } from '../shared/types'

let agentService: AgentService | null = null

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

function registerIpc(): void {
  const argusHome = resolveArgusHome()
  const db = openDb(dbPath(argusHome))
  seedSharedDirs(argusHome, resolveAssetSource(app.getAppPath()))

  // capture user-set env BEFORE this block mutates the process env (badge sources)
  const envOverrides = {
    traceDir: process.env.ARGUS_TRACE_DIR,
    parseBin: process.env.ARGUS_PARSE_BIN
  }
  const settingsService = new SettingsService(argusHome, app.getAppPath(), envOverrides)

  const secretStore = new SecretStore(argusHome, safeStorage)
  const connectorRegistry = new ConnectorRegistry(argusHome)
  const toolRiskStore = new ToolRiskStore(argusHome)
  const connectorPresets = loadPresets(argusHome)
  const mcpOauth = new McpOAuth(secretStore, (url) => shell.openExternal(url))
  const mcpService = new McpService({
    registry: connectorRegistry,
    secrets: secretStore,
    toolRisk: () => toolRiskStore.get(),
    oauth: mcpOauth
  })

  const connectorsPayload = (): ConnectorsPayload => ({
    connectors: connectorRegistry.get(),
    runtime: mcpService.runtimeStates(),
    oauth: Object.fromEntries(
      Object.keys(connectorRegistry.get()).map((id) => [id, mcpOauth.status(id)])
    ),
    rest: {},
    loadError: connectorRegistry.loadError(),
    secretsAvailable: secretStore.available(),
    secretsLoadError: secretStore.loadError(),
    presets: connectorPresets
  })

  connectorRegistry.subscribe(() => broadcast(IPC.connectorsChanged, connectorsPayload()))

  // agent sessions and preflight inherit this process env — make sample-trace findable
  ensureTraceOnPath(app.getAppPath(), settingsService.get().tools.traceDir || undefined)
  // …and sample-parse (Python delegation + agent Bash read ARGUS_PARSE_BIN)
  let argusParseBin: string | null = null
  const recomputeParseBin = (): void => {
    argusParseBin = resolveArgusParse(
      app.getAppPath(),
      settingsService.get().tools.parseBin || undefined,
      envOverrides.parseBin ?? null
    )
    // export for spawned children (agent Bash, extraction CLIs); never clobber a user-set env
    if (!envOverrides.parseBin) {
      if (argusParseBin) process.env.ARGUS_PARSE_BIN = argusParseBin
      else delete process.env.ARGUS_PARSE_BIN
    }
  }
  recomputeParseBin()

  // shared with the agent:auth-status handler below — settings changes (e.g. a new
  // cliPath) must invalidate the cached probe result so the next open re-probes
  let cachedAuth: AuthStatus | null = null
  settingsService.subscribe(() => {
    recomputeParseBin()
    cachedAuth = null
    broadcast(IPC.settingsChanged, settingsService.payload())
  })

  // — wave 0 handlers unchanged —
  ipcMain.handle(IPC.casesCreate, (_e, input: NewCaseInput) => createCase(db, argusHome, input))
  ipcMain.handle(IPC.casesList, () => listCases(db))
  ipcMain.handle(IPC.evidenceIngest, (_e, caseSlug: string, absPaths: string[]) => {
    const records = absPaths.map((p) => ingestArtifact(db, argusHome, caseSlug, p))
    // fire-and-forget: derived text appears via evidence:changed when ready
    for (const rec of records) {
      void extractDerivedText(db, argusHome, rec, { argusParse: argusParseBin }).then((derived) => {
        if (derived) broadcast(IPC.evidenceChanged, caseSlug)
      })
    }
    return records
  })
  ipcMain.handle(IPC.evidenceList, (_e, caseSlug: string) => listEvidence(db, caseSlug))
  ipcMain.handle(IPC.evidenceRead, (_e, evidenceId: number, focusLine?: number) =>
    readEvidenceText(db, argusHome, evidenceId, focusLine)
  )
  ipcMain.handle(IPC.searchQuery, (_e, q: string, filters?: SearchFilters) =>
    searchEvidence(db, q, filters ?? {})
  )

  // — agent —
  agentService = new AgentService({
    db,
    argusHome,
    skillsRoots: [sharedSkillsDir(argusHome), sharedReferencesDir(argusHome)],
    onEvent: (e) => broadcast(IPC.agentEventChannel, e),
    agentSettings: () => settingsService.get().agent,
    composeMcp: () => mcpService.composeForSession(),
    toolRisk: () => toolRiskStore.get(),
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
  ipcMain.handle(IPC.agentSend, (_e, caseSlug: string, text: string) =>
    agentService!.send(caseSlug, text)
  )
  ipcMain.handle(IPC.agentInterrupt, (_e, caseSlug: string) => agentService!.interrupt(caseSlug))
  ipcMain.handle(IPC.agentRespond, (_e, caseSlug: string, d: ApprovalDecision) =>
    agentService!.respond(caseSlug, d)
  )
  ipcMain.handle(IPC.agentAuthStatus, async (_e, force?: boolean) => {
    if (force) cachedAuth = null
    if (!cachedAuth) {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      const status = await probeAuth(
        (args) => query({ prompt: args.prompt as never, options: args.options as never }) as never,
        {
          timeoutMs: settingsService.get().agent.probeTimeoutMs,
          cliPath: activeInstanceConfig(settingsService.get()).cliPath
        }
      )
      // only cache success — a failed probe should retry on the next case open
      if (status.ok) cachedAuth = status
      return status
    }
    return cachedAuth
  })
  ipcMain.handle(IPC.agentPreflight, () => runPreflight(argusParseBin))
  ipcMain.handle(IPC.agentHistory, (_e, caseSlug: string) =>
    readSessionEvents(caseDir(argusHome, caseSlug))
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

  // — skills —
  ipcMain.handle(IPC.skillsList, () => listSkills(argusHome))

  // — settings —
  ipcMain.handle(IPC.settingsGet, () => settingsService.payload())
  ipcMain.handle(IPC.settingsPatch, (_e, p: unknown) => {
    settingsService.patch(p)
    return settingsService.payload()
  })
  ipcMain.handle(IPC.settingsProbeTools, () => settingsService.probeTools())
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

  // — connectors + secrets —
  ipcMain.handle(IPC.connectorsGet, () => connectorsPayload())
  ipcMain.handle(IPC.connectorsPatch, (_e, p: unknown) => {
    const before = Object.keys(connectorRegistry.get())
    connectorRegistry.patch(p)
    const after = new Set(Object.keys(connectorRegistry.get()))
    for (const id of before) {
      if (!after.has(id)) {
        mcpOauth.clear(id)
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
    const r = await mcpOauth.authorize(id, cfg.url)
    // release a compose-set needs-auth latch so the next session includes the connector
    if (r.ok) mcpService.clearRuntime(id)
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
    probeTools: () => settingsService.probeTools(),
    preflight: () => runPreflight(argusParseBin),
    agentAuth: async () => {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      return probeAuth(
        (args) => query({ prompt: args.prompt as never, options: args.options as never }) as never,
        {
          timeoutMs: settingsService.get().agent.probeTimeoutMs,
          cliPath: activeInstanceConfig(settingsService.get()).cliPath
        }
      )
    },
    enabledConnectors: () =>
      Object.entries(connectorRegistry.get())
        .filter(([, i]) => i.enabled)
        .map(([id]) => id),
    probeConnector: (id) => mcpService.probe(id)
  })

  ipcMain.handle(IPC.healthList, () => healthService.rows())
  ipcMain.handle(IPC.healthRun, async (_e, ids?: string[]) => {
    await healthService.run(ids ?? null, (r) => broadcast(IPC.healthResult, r))
  })
  ipcMain.handle(IPC.sourceControlStatus, () => ghStatus())
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

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

app.on('before-quit', () => {
  void agentService?.stopAll()
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
