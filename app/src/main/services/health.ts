import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AuthStatus } from '../../shared/types'
import type { DiscoveredTool } from '../../shared/connectors'
import type { HealthCheckResult, HealthRow } from '../../shared/health'

const execFileAsync = promisify(execFile)

export interface HealthDeps {
  argusHome: string
  /** Pack-declared binaries: one health row each (id 'bin:<id>'). */
  binaries: () => Array<{ id: string; label: string }>
  checkBinary: (id: string) => Promise<{ ok: boolean; detail: string; fixHint?: string }>
  agentAuth: () => Promise<AuthStatus>
  /** Injectable for tests; defaults to spawning `gh auth status`. */
  gh?: () => Promise<{ ok: boolean; detail: string }>
  /** Enabled connector instances: id + human label (displayName, id as fallback). */
  enabledConnectors: () => Array<{ id: string; name: string }>
  probeConnector: (id: string) => Promise<{ ok: boolean; tools?: DiscoveredTool[]; error?: string }>
  atlassianConfigured: () => boolean
  atlassianCheck: () => Promise<{ ok: boolean; detail: string }>
  refsyncConfigured: () => boolean
  confluenceCheck: () => Promise<{ ok: boolean; detail: string }>
  langfuseConfigured: () => boolean
  langfuseCheck: () => Promise<{ ok: boolean; detail: string }>
}

const STATIC_ROWS: HealthRow[] = [
  { id: 'gh', label: 'GitHub CLI auth', category: 'general' },
  { id: 'agent', label: 'Agent auth', category: 'general' },
  { id: 'data-root', label: 'Data root writable', category: 'general' }
]

/** The ex-/doctor checks (spec §2.7). Failures render as chips + fix hints; nothing here throws. */
export class HealthService {
  constructor(private deps: HealthDeps) {}

  rows(): HealthRow[] {
    return [
      ...this.deps
        .binaries()
        .map((b) => ({ id: `bin:${b.id}`, label: b.label, category: 'tools' as const })),
      ...STATIC_ROWS,
      ...(this.deps.atlassianConfigured()
        ? [
            {
              id: 'atlassian-rest',
              label: 'Atlassian REST (Jira)',
              category: 'connectors' as const
            }
          ]
        : []),
      ...(this.deps.refsyncConfigured()
        ? [
            {
              id: 'confluence-rest',
              label: 'Atlassian REST (Confluence)',
              category: 'connectors' as const
            }
          ]
        : []),
      ...(this.deps.langfuseConfigured()
        ? [{ id: 'langfuse', label: 'Langfuse (observability)', category: 'connectors' as const }]
        : []),
      ...this.deps
        .enabledConnectors()
        .map((c) => ({ id: `connector:${c.id}`, label: c.name, category: 'connectors' as const }))
    ]
  }

  /** Runs (a subset of) the checks concurrently, emitting each result as it completes. */
  async run(ids: string[] | null, emit: (r: HealthCheckResult) => void): Promise<void> {
    const rows = this.rows().filter((r) => !ids || ids.includes(r.id))
    await Promise.all(rows.map(async (row) => emit(await this.check(row))))
  }

  private async check(row: HealthRow): Promise<HealthCheckResult> {
    try {
      if (row.id.startsWith('bin:')) {
        const r = await this.deps.checkBinary(row.id.slice('bin:'.length))
        return {
          ...row,
          ok: r.ok,
          detail: r.detail,
          ...(r.ok ? {} : { fixHint: r.fixHint })
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
      if (row.id === 'atlassian-rest') {
        const r = await this.deps.atlassianCheck()
        return {
          ...row,
          ok: r.ok,
          detail: r.detail,
          ...(r.ok
            ? {}
            : {
                fixHint: 'Re-authorize the Atlassian connector (Settings → Connectors).'
              })
        }
      }
      if (row.id === 'confluence-rest') {
        const r = await this.deps.confluenceCheck()
        return {
          ...row,
          ok: r.ok,
          detail: r.detail,
          ...(r.ok
            ? {}
            : {
                fixHint: 'Re-authorize the Atlassian connector (Settings → Connectors).'
              })
        }
      }
      if (row.id === 'langfuse') {
        const r = await this.deps.langfuseCheck()
        return {
          ...row,
          ok: r.ok,
          detail: r.detail,
          ...(r.ok
            ? {}
            : {
                fixHint:
                  'Check host URL + keys on Settings → Observability, and that your Langfuse instance is reachable.'
              })
        }
      }
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
