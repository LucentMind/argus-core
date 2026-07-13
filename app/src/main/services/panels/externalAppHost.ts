import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { PanelKey, ExternalAppInfo } from '../../../shared/panels'
import { panelKeyStr } from '../../../shared/panels'
import type { PanelDispatchResult } from './panelHost'

export type { ExternalAppInfo }
export type DispatchResult = PanelDispatchResult

export interface ProcessHandle {
  readonly pid: number
  writeLine(line: string): void
  onStdoutLine(cb: (line: string) => void): void
  onStderr(cb: (chunk: string) => void): void
  onExit(cb: (code: number | null) => void): void
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
  /** Best-effort OS raise; may be a no-op for some processes/platforms. */
  focus(): void
}

export interface ProcessSpawner {
  spawn(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string> }): ProcessHandle
}

export interface OpenExternalAppInput extends PanelKey {
  title: string
  /** Absolute path to the executable (or the node script when runtime==='node'). */
  entry: string
  /** Working directory for the child (the pack dir). */
  cwd: string
  runtime?: 'node'
}

interface RunningApp {
  input: OpenExternalAppInput
  handle: ProcessHandle
  status: 'running' | 'exited'
  stdoutBuf: string
  killTimer?: ReturnType<typeof setTimeout>
}

const KILL_GRACE_MS = 5000

export class ExternalAppHost {
  private readonly apps = new Map<string, RunningApp>()
  private readonly pending = new Map<
    string,
    { key: string; resolve: (r: DispatchResult) => void; timer: ReturnType<typeof setTimeout> }
  >()

  constructor(
    private readonly deps: {
      spawner: ProcessSpawner
      logDir: string
      onChange?: () => void
      dispatchTimeoutMs?: number
    }
  ) {}

  open(input: OpenExternalAppInput): ExternalAppInfo {
    const key = panelKeyStr(input)
    const existing = this.apps.get(key)
    if (existing && existing.status === 'running') {
      existing.handle.focus()
      return infoOf(existing)
    }
    const { cmd, args, env } = resolveCommand(input)
    const handle = this.deps.spawner.spawn(cmd, args, { cwd: input.cwd, env })
    const app: RunningApp = { input, handle, status: 'running', stdoutBuf: '' }
    this.apps.set(key, app)

    handle.onStdoutLine((line) => this.onStdout(key, line))
    handle.onStderr((chunk) => this.appendLog(input, chunk))
    handle.onExit(() => this.onExit(key))
    return infoOf(app)
  }

  focus(key: PanelKey): void {
    this.apps.get(panelKeyStr(key))?.handle.focus()
  }

  stop(key: PanelKey): void {
    const k = panelKeyStr(key)
    const app = this.apps.get(k)
    if (app && app.status === 'exited') {
      // A spent chip's Stop button becomes a dismiss: an already-exited app
      // never re-enters terminate(), so this is the only way to clear it.
      this.apps.delete(k)
      this.deps.onChange?.()
      return
    }
    this.terminate(k)
  }

  dispatchToProcess(key: PanelKey, cmd: string, args: unknown[]): Promise<DispatchResult> {
    const k = panelKeyStr(key)
    const app = this.apps.get(k)
    if (!app || app.status !== 'running') {
      return Promise.resolve({ ok: false, reason: 'process-exited', hint: 'call mcp__argus__open_panel first' })
    }
    const requestId = crypto.randomUUID()
    return new Promise<DispatchResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) resolve({ ok: false, reason: 'timeout' })
      }, this.deps.dispatchTimeoutMs ?? 15000)
      this.pending.set(requestId, { key: k, resolve, timer })
      app.handle.writeLine(JSON.stringify({ requestId, cmd, args }))
    })
  }

  list(caseSlug?: string): ExternalAppInfo[] {
    const out: ExternalAppInfo[] = []
    for (const a of this.apps.values()) {
      if (!caseSlug || a.input.caseSlug === caseSlug) out.push(infoOf(a))
    }
    return out
  }

  closeCase(caseSlug: string): void {
    for (const [k, a] of this.apps) if (a.input.caseSlug === caseSlug) this.terminate(k)
  }

  closeAll(): void {
    for (const k of [...this.apps.keys()]) this.terminate(k)
  }

  private onStdout(key: string, chunk: string): void {
    const app = this.apps.get(key)
    if (!app) return
    app.stdoutBuf += chunk
    const lines = app.stdoutBuf.split(/\r?\n/)
    app.stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let msg: { requestId?: string; ok?: boolean; result?: unknown; error?: string }
      try {
        msg = JSON.parse(trimmed)
      } catch {
        continue // non-JSON stdout noise — ignore
      }
      if (!msg.requestId) continue
      const entry = this.pending.get(msg.requestId)
      if (!entry) continue
      clearTimeout(entry.timer)
      this.pending.delete(msg.requestId)
      entry.resolve(
        msg.ok ? { ok: true, result: msg.result } : { ok: false, reason: 'error', hint: msg.error }
      )
    }
  }

  private onExit(key: string): void {
    const app = this.apps.get(key)
    if (!app) return
    app.status = 'exited'
    if (app.killTimer) clearTimeout(app.killTimer)
    for (const [rid, entry] of this.pending) {
      if (entry.key === key) {
        clearTimeout(entry.timer)
        this.pending.delete(rid)
        entry.resolve({ ok: false, reason: 'process-exited' })
      }
    }
    this.deps.onChange?.()
  }

  private terminate(key: string): void {
    const app = this.apps.get(key)
    if (!app || app.status !== 'running') return
    if (app.killTimer) return // a kill is already in flight — don't send a second SIGTERM/leak the timer
    app.handle.kill('SIGTERM')
    app.killTimer = setTimeout(() => {
      if (this.apps.get(key)?.status === 'running') app.handle.kill('SIGKILL')
    }, KILL_GRACE_MS)
  }

  private appendLog(input: OpenExternalAppInput, chunk: string): void {
    try {
      fs.mkdirSync(this.deps.logDir, { recursive: true })
      const caseSlug = input.caseSlug.replace(/[^a-zA-Z0-9._-]/g, '-')
      fs.appendFileSync(
        path.join(this.deps.logDir, `${caseSlug}_${input.packId}_${input.windowId}.log`),
        chunk
      )
    } catch {
      // logging is best-effort
    }
  }
}

/** node runtime → run the bundled runtime as node; else spawn the entry directly. Pure/testable. */
export function resolveCommand(input: OpenExternalAppInput): {
  cmd: string
  args: string[]
  env?: Record<string, string>
} {
  if (input.runtime === 'node') {
    return { cmd: process.execPath, args: [input.entry], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { cmd: input.entry, args: [] }
}

function infoOf(a: RunningApp): ExternalAppInfo {
  return {
    caseSlug: a.input.caseSlug,
    packId: a.input.packId,
    windowId: a.input.windowId,
    title: a.input.title,
    status: a.status
  }
}
