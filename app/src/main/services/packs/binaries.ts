import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { PackBinary } from './manifest'
import type { PreflightReport } from '../../../shared/types'
import type { ResolvedToolRow, ProbeToolRow } from '../../../shared/settings'
import type { PackRegistry } from './registry'

const execFileAsync = promisify(execFile)

export type BinarySource = 'env' | 'settings' | 'pack-bundle' | 'pack-dev' | 'path'

export interface ResolvedBinary {
  decl: PackBinary
  packDir: string
  value: string | null
  source: BinarySource | null
}

export interface ResolveCtx {
  packDir: string
  /**
   * USER-set env value for decl.envVar, captured by the caller at startup —
   * deliberately no process.env default: the app exports resolved values back
   * into its own env for spawned children, and a live read here would let
   * that export shadow settings (the parsers.ts footgun this design removes).
   */
  envValue: string | null
  settingsValue: string | undefined
}

function platformBin(): string {
  return process.platform === 'win32' ? 'Scripts' : 'bin'
}

function exeCandidates(name: string): string[] {
  return process.platform === 'win32' ? [`${name}.exe`, name] : [name, `${name}.exe`]
}

export function firstExistingExe(dir: string, names: string[]): string | null {
  for (const name of names) {
    for (const cand of exeCandidates(name)) {
      const p = path.join(dir, cand)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

export function resolveBinary(decl: PackBinary, ctx: ResolveCtx): ResolvedBinary {
  const found = (value: string | null, source: BinarySource | null): ResolvedBinary => ({
    decl,
    packDir: ctx.packDir,
    value,
    source
  })

  if (ctx.envValue && fs.existsSync(ctx.envValue)) return found(ctx.envValue, 'env')
  if (ctx.settingsValue && fs.existsSync(ctx.settingsValue))
    return found(ctx.settingsValue, 'settings')

  const bundleDir = path.join(ctx.packDir, 'bin')
  const devDirs = decl.devPaths.map((p) =>
    path.resolve(ctx.packDir, p.replaceAll('{platformBin}', platformBin()))
  )

  if (decl.kind === 'pathDir') {
    // A published bundle ships the pathDir's executables under bin/; that dir goes on PATH.
    if (firstExistingExe(bundleDir, decl.names)) return found(bundleDir, 'pack-bundle')
    for (const d of devDirs) if (fs.existsSync(d)) return found(d, 'pack-dev')
    return found(null, null)
  }

  const bundleHit = firstExistingExe(bundleDir, decl.names)
  if (bundleHit) return found(bundleHit, 'pack-bundle')
  for (const d of devDirs) {
    const hit = firstExistingExe(d, decl.names)
    if (hit) return found(hit, 'pack-dev')
  }
  if (decl.pathProbeArgs) {
    try {
      execFileSync(decl.names[0], decl.pathProbeArgs, { stdio: 'ignore', timeout: 3000 })
      return found(decl.names[0], 'path')
    } catch {
      /* fall through */
    }
  }
  // `uv tool install` / `pipx install` both default to ~/.local/bin on every platform
  // (incl. Windows). A long-running app's process.env.PATH is captured at launch, so a
  // tool installed after Argus started won't resolve via the PATH probe above until
  // restart — check the well-known install dir directly so it's picked up immediately.
  const userLocalBinHit = firstExistingExe(path.join(os.homedir(), '.local', 'bin'), decl.names)
  if (userLocalBinHit) return found(userLocalBinHit, 'path')
  return found(null, null)
}

export interface BinariesServiceDeps {
  registry: PackRegistry
  /** Live settings.tools (loose object — pack settingsKeys may be extra keys). */
  settingsTools: () => Record<string, unknown>
  /** User env snapshot for declared envVars; defaults to a live snapshot AT CONSTRUCTION. */
  capturedEnv?: Record<string, string | undefined>
}

export class BinariesService {
  private captured: Record<string, string | undefined>
  private resolved = new Map<string, ResolvedBinary>()

  constructor(private deps: BinariesServiceDeps) {
    this.captured =
      deps.capturedEnv ??
      Object.fromEntries(
        deps.registry
          .binaryDecls()
          .filter(({ decl }) => decl.envVar)
          .map(({ decl }) => [decl.envVar as string, process.env[decl.envVar as string]])
      )
    this.recompute()
  }

  recompute(): void {
    const tools = this.deps.settingsTools()
    this.resolved = new Map()
    for (const { packDir, decl } of this.deps.registry.binaryDecls()) {
      if (
        decl.platforms &&
        !decl.platforms.includes(process.platform as 'win32' | 'darwin' | 'linux')
      ) {
        continue // declared for other platforms only
      }
      if (this.resolved.has(decl.id)) {
        console.warn(`[packs] duplicate binary id '${decl.id}' — first declaration wins`)
        continue
      }
      const raw = decl.settingsKey ? tools[decl.settingsKey] : undefined
      this.resolved.set(
        decl.id,
        resolveBinary(decl, {
          packDir,
          envValue: decl.envVar ? (this.captured[decl.envVar] ?? null) : null,
          settingsValue: typeof raw === 'string' && raw !== '' ? raw : undefined
        })
      )
    }
    this.applyEnvExports()
  }

  /** exe: export envVar for spawned children unless the USER set it; pathDir: prepend to PATH once. */
  private applyEnvExports(): void {
    for (const r of this.resolved.values()) {
      if (r.decl.kind === 'pathDir') {
        if (r.value) {
          const cur = process.env.PATH ?? ''
          if (!cur.split(path.delimiter).includes(r.value)) {
            process.env.PATH = r.value + path.delimiter + cur
          }
        }
      } else if (r.decl.envVar) {
        const envVar = r.decl.envVar
        const userSet = this.captured[envVar]
        if (!userSet) {
          // nothing captured from the user's env — export the resolved value for children
          if (r.value) process.env[envVar] = r.value
          else delete process.env[envVar]
        } else if (r.source === 'env') {
          // resolved value IS the user's captured value (env wins in resolveBinary) — re-affirming
          // it is a no-op, not a clobber, and keeps process.env in sync across service instances
          process.env[envVar] = r.value as string
        }
        // else: the user set envVar but it didn't resolve (missing file) and resolution fell back
        // elsewhere — never clobber their explicit setting with a different value
      }
    }
  }

  all(): ResolvedBinary[] {
    return [...this.resolved.values()]
  }

  get(id: string): ResolvedBinary | undefined {
    return this.resolved.get(id)
  }

  pathOf(id: string): string | null {
    return this.resolved.get(id)?.value ?? null
  }

  settingsRows(): ResolvedToolRow[] {
    const tools = this.deps.settingsTools()
    return this.all().map((r) => ({
      id: r.decl.id,
      displayName: r.decl.displayName,
      description: r.decl.description,
      kind: r.decl.kind,
      envVar: r.decl.envVar ?? null,
      settingsKey: r.decl.settingsKey ?? null,
      settingsValue: r.decl.settingsKey ? String(tools[r.decl.settingsKey] ?? '') : '',
      value: r.value,
      source: r.source === 'env' ? 'env' : r.source === 'settings' ? 'settings' : 'default'
    }))
  }

  private async version(r: ResolvedBinary): Promise<string | null> {
    if (!r.value || !r.decl.versionArgs) return null
    try {
      const { stdout } = await execFileAsync(r.value, r.decl.versionArgs, { timeout: 3000 })
      return stdout.trim() || null
    } catch {
      return null // binary exists but version probe failed; path still reported
    }
  }

  async probe(): Promise<ProbeToolRow[]> {
    return Promise.all(
      this.all().map(async (r) => {
        if (r.decl.kind === 'pathDir') {
          const found = r.value != null && firstExistingExe(r.value, r.decl.names) != null
          return {
            id: r.decl.id,
            ok: found,
            chip: found ? 'found' : 'not found',
            detail: found ? (r.value as string) : 'not found'
          }
        }
        if (!r.value) return { id: r.decl.id, ok: false, chip: 'not found', detail: 'not found' }
        const v = await this.version(r)
        return {
          id: r.decl.id,
          ok: true,
          chip: v ? `found · ${v}` : 'found',
          detail: v ? `${r.value} · ${v}` : r.value
        }
      })
    )
  }

  /** One health check per binary (exe: probe; pathDir: doctor run). */
  async healthCheck(id: string): Promise<{ ok: boolean; detail: string; fixHint?: string }> {
    const r = this.resolved.get(id)
    if (!r) return { ok: false, detail: 'unknown binary' }
    const fixHint = r.decl.fixHint || undefined
    if (r.decl.kind === 'exe') {
      if (!r.value) return { ok: false, detail: 'not found', fixHint }
      const v = await this.version(r)
      return { ok: true, detail: v ? `${r.value} · ${v}` : r.value }
    }
    const checks = await this.doctorChecks(r)
    const bad = checks.filter((c) => !c.ok)
    return bad.length === 0
      ? { ok: true, detail: `${checks.length} checks passed` }
      : { ok: false, detail: bad.map((c) => `${c.name}: ${c.detail}`).join('; '), fixHint }
  }

  private async doctorChecks(r: ResolvedBinary): Promise<PreflightReport['checks']> {
    const doctor = r.decl.doctor
    if (!doctor) {
      return [
        { name: r.decl.id, ok: r.value != null, detail: r.value ?? (r.decl.fixHint || 'not found') }
      ]
    }
    try {
      const { stdout } = await execFileAsync(doctor.cmd, doctor.args, { timeout: 5000 })
      if (doctor.json) return (JSON.parse(stdout) as PreflightReport).checks
      return [{ name: r.decl.id, ok: true, detail: 'ok' }]
    } catch (err) {
      const hint = r.decl.fixHint ? ` — ${r.decl.fixHint}` : ''
      const detail =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `${doctor.cmd} not installed${hint}`
          : `${(err as Error).message}${hint}`
      return [{ name: r.decl.id, ok: false, detail }]
    }
  }

  /** Aggregated report in decl order (ports agent/preflight.ts runPreflight). */
  async preflight(): Promise<PreflightReport> {
    const checks: PreflightReport['checks'] = []
    for (const r of this.all()) {
      if (r.decl.kind === 'exe') {
        checks.push({
          name: r.decl.id,
          ok: r.value != null,
          detail: r.value ?? (r.decl.fixHint || 'not found')
        })
      } else {
        checks.push(...(await this.doctorChecks(r)))
      }
    }
    const seen = new Set<string>()
    const deduped = checks.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
    return { ok: deduped.every((c) => c.ok), checks: deduped }
  }
}
