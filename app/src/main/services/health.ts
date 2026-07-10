import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProbeToolsReport } from '../../shared/settings'
import type { AuthStatus, PreflightReport } from '../../shared/types'
import type { DiscoveredTool } from '../../shared/connectors'
import type { HealthCheckResult, HealthRow } from '../../shared/health'

const execFileAsync = promisify(execFile)

export interface HealthDeps {
  argusHome: string
  probeTools: () => Promise<ProbeToolsReport>
  preflight: () => Promise<PreflightReport>
  agentAuth: () => Promise<AuthStatus>
  /** Injectable for tests; defaults to spawning `gh auth status`. */
  gh?: () => Promise<{ ok: boolean; detail: string }>
  enabledConnectors: () => string[]
  probeConnector: (id: string) => Promise<{ ok: boolean; tools?: DiscoveredTool[]; error?: string }>
}

const STATIC_ROWS: HealthRow[] = [
  { id: 'parse', label: 'sample-parse binary' },
  { id: 'trace', label: 'sample-trace CLI + Python env' },
  { id: 'gh', label: 'GitHub CLI auth' },
  { id: 'agent', label: 'Agent auth' },
  { id: 'data-root', label: 'Data root writable' }
]

/** The ex-/doctor checks (spec §2.7). Failures render as chips + fix hints; nothing here throws. */
export class HealthService {
  constructor(private deps: HealthDeps) {}

  rows(): HealthRow[] {
    return [
      ...STATIC_ROWS,
      ...this.deps
        .enabledConnectors()
        .map((id) => ({ id: `connector:${id}`, label: `Connector: ${id}` }))
    ]
  }

  /** Runs (a subset of) the checks concurrently, emitting each result as it completes. */
  async run(ids: string[] | null, emit: (r: HealthCheckResult) => void): Promise<void> {
    const rows = this.rows().filter((r) => !ids || ids.includes(r.id))
    await Promise.all(rows.map(async (row) => emit(await this.check(row))))
  }

  private async check(row: HealthRow): Promise<HealthCheckResult> {
    try {
      if (row.id === 'parse') {
        const r = await this.deps.probeTools()
        return r.parseBin.path
          ? {
              ...row,
              ok: true,
              detail: `${r.parseBin.path}${r.parseBin.version ? ` · ${r.parseBin.version}` : ''}`
            }
          : {
              ...row,
              ok: false,
              detail: 'not found',
              fixHint: 'Set the path in Settings → Analysis Tools, or build trace-rs.'
            }
      }
      if (row.id === 'trace') {
        const r = await this.deps.preflight()
        if (r.ok) return { ...row, ok: true, detail: `${r.checks.length} checks passed` }
        const bad = r.checks.filter((c) => !c.ok)
        return {
          ...row,
          ok: false,
          detail: bad.map((c) => `${c.name}: ${c.detail}`).join('; '),
          fixHint: 'Set up the trace-tools Python env (docs/DEVELOPMENT.md).'
        }
      }
      if (row.id === 'gh') {
        const r = await (this.deps.gh ?? defaultGh)()
        return {
          ...row,
          ok: r.ok,
          detail: r.detail,
          ...(r.ok ? {} : { fixHint: 'Install the GitHub CLI and run `gh auth login`.' })
        }
      }
      if (row.id === 'agent') {
        const r = await this.deps.agentAuth()
        return {
          ...row,
          ok: r.ok,
          detail: r.detail,
          ...(r.ok ? {} : { fixHint: 'Log in with `claude login` (or set ANTHROPIC_API_KEY).' })
        }
      }
      if (row.id === 'data-root') return this.checkDataRoot(row)
      if (row.id.startsWith('connector:')) {
        const id = row.id.slice('connector:'.length)
        const r = await this.deps.probeConnector(id)
        return r.ok
          ? { ...row, ok: true, detail: `connected · ${r.tools?.length ?? 0} tools` }
          : {
              ...row,
              ok: false,
              detail: r.error ?? 'failed',
              fixHint: 'Open Settings → Connectors and run Test connection.'
            }
      }
      return { ...row, ok: false, detail: 'unknown check' }
    } catch (err) {
      return { ...row, ok: false, detail: (err as Error).message }
    }
  }

  private checkDataRoot(row: HealthRow): HealthCheckResult {
    const probe = path.join(this.deps.argusHome, `.health-${process.pid}.tmp`)
    try {
      fs.mkdirSync(this.deps.argusHome, { recursive: true })
      fs.writeFileSync(probe, 'ok')
      fs.rmSync(probe)
      return { ...row, ok: true, detail: this.deps.argusHome }
    } catch (err) {
      return {
        ...row,
        ok: false,
        detail: (err as Error).message,
        fixHint: 'Check permissions on the data root (ARGUS_HOME).'
      }
    }
  }
}

async function defaultGh(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status'], { timeout: 10000 })
    const line = (stdout + stderr).split('\n').find((l) => l.includes('Logged in'))
    return { ok: true, detail: (line ?? 'authenticated').trim() }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    if (e.code === 'ENOENT') return { ok: false, detail: 'gh not installed' }
    return {
      ok: false,
      detail: (e.stderr ?? e.message ?? 'not authenticated').trim().split('\n')[0]
    }
  }
}
