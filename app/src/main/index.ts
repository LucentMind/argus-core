import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path, { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC } from '../shared/ipc'
import { resolveArgusHome, dbPath, caseDir } from './services/paths'
import { openDb } from './services/db'
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
  // agent sessions and preflight inherit this process env — make sample-trace findable
  ensureTraceOnPath(app.getAppPath())
  // …and sample-parse (Python delegation + agent Bash read ARGUS_PARSE_BIN)
  const argusParseBin = resolveArgusParse(app.getAppPath())
  if (argusParseBin) process.env.ARGUS_PARSE_BIN ??= argusParseBin

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
  ipcMain.handle(IPC.evidenceRead, (_e, evidenceId: number) =>
    readEvidenceText(db, argusHome, evidenceId)
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
  let cachedAuth: AuthStatus | null = null
  ipcMain.handle(IPC.agentAuthStatus, async () => {
    if (!cachedAuth) {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      const status = await probeAuth(
        (args) => query({ prompt: args.prompt as never, options: args.options as never }) as never
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
