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
  type SettingsPayload
} from '../../shared/settings'

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
        : { value: resolveTraceBinDir(this.appRoot), source: 'default' }
    const parseBin: ResolvedTool = this.env.parseBin
      ? { value: this.env.parseBin, source: 'env' }
      : t.parseBin
        ? { value: t.parseBin, source: 'settings' }
        : { value: resolveArgusParse(this.appRoot), source: 'default' }
    return { traceDir, parseBin }
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
