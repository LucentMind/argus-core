import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { JsonFileStore } from './fileStore'
import { settingsPath } from './paths'
import { resolveTraceBinDir } from './agent/preflight'
import { resolveArgusParse } from './parsers'
import {
  settingsSchema,
  defaultSettings,
  deepMerge,
  stripDefaults,
  type AppSettings,
  type ResolvedTool,
  type SettingsPayload,
  type ProbeToolsReport
} from '../../shared/settings'

const execFileAsync = promisify(execFile)

/**
 * User-set env values captured at startup, BEFORE index.ts mutates the
 * process env (it sets ARGUS_PARSE_BIN and prepends the trace dir to PATH).
 */
export interface EnvOverrides {
  traceDir: string | undefined
  parseBin: string | undefined
}

export class SettingsService {
  private store: JsonFileStore
  private settings: AppSettings
  private error: string | null = null
  private listeners = new Set<() => void>()
  private unwatch: () => void

  constructor(
    private argusHome: string,
    private appRoot: string,
    private env: EnvOverrides = {
      traceDir: process.env.ARGUS_TRACE_DIR,
      parseBin: process.env.ARGUS_PARSE_BIN
    },
    private opts: { argusHomeFromEnv?: boolean } = {
      argusHomeFromEnv: process.env.ARGUS_HOME != null
    }
  ) {
    this.store = new JsonFileStore(settingsPath(argusHome))
    this.settings = this.loadNow()
    this.unwatch = this.store.watch(() => {
      this.settings = this.loadNow()
      this.notify()
    })
  }

  private loadNow(): AppSettings {
    const { data, error } = this.store.load()
    this.error = error
    const r = settingsSchema.safeParse(data)
    if (r.success) return r.data
    this.error = this.error ?? r.error.message
    return defaultSettings()
  }

  private notify(): void {
    for (const cb of this.listeners) cb()
  }

  get(): AppSettings {
    return this.settings
  }

  loadError(): string | null {
    return this.error
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  patch(partial: unknown): AppSettings {
    this.settings = settingsSchema.parse(deepMerge(this.settings, partial))
    this.store.write(stripDefaults(this.settings, defaultSettings()))
    this.error = null // an explicit save replaces a previously broken file
    this.notify()
    return this.settings
  }

  /** env var > settings.json > auto-resolve; 'default' value may be null (nothing found). */
  resolvedTools(): { traceDir: ResolvedTool; parseBin: ResolvedTool } {
    const t = this.settings.tools
    const traceDir: ResolvedTool = this.env.traceDir
      ? { value: this.env.traceDir, source: 'env' }
      : t.traceDir
        ? { value: t.traceDir, source: 'settings' }
        : { value: resolveTraceBinDir(this.appRoot, t.traceDir || undefined), source: 'default' }
    const parseBin: ResolvedTool = this.env.parseBin
      ? { value: this.env.parseBin, source: 'env' }
      : t.parseBin
        ? { value: t.parseBin, source: 'settings' }
        : { value: resolveArgusParse(this.appRoot, t.parseBin || undefined), source: 'default' }
    return { traceDir, parseBin }
  }

  /** Re-run tool resolution + liveness checks for the Analysis Tools page. */
  async probeTools(): Promise<ProbeToolsReport> {
    const { traceDir, parseBin } = this.resolvedTools()
    let version: string | null = null
    if (parseBin.value && fs.existsSync(parseBin.value)) {
      try {
        const { stdout } = await execFileAsync(parseBin.value, ['--version'], { timeout: 3000 })
        version = stdout.trim() || null
      } catch {
        version = null // binary exists but --version failed; path still reported
      }
    }
    const found = traceDir.value
      ? fs.existsSync(
          path.join(
            traceDir.value,
            process.platform === 'win32' ? 'sample-trace.exe' : 'sample-trace'
          )
        )
      : false
    return {
      parseBin: {
        path: parseBin.value && fs.existsSync(parseBin.value) ? parseBin.value : null,
        version
      },
      traceDir: { path: traceDir.value, found }
    }
  }

  payload(): SettingsPayload {
    return {
      settings: this.settings,
      resolvedTools: this.resolvedTools(),
      dataRoot: { path: this.argusHome, fromEnv: Boolean(this.opts.argusHomeFromEnv) },
      loadError: this.error
    }
  }

  close(): void {
    this.unwatch()
    this.store.close()
  }
}
