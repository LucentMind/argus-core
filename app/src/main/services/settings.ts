import { JsonFileStore } from './fileStore'
import { settingsPath } from './paths'
import {
  settingsSchema,
  defaultSettings,
  deepMerge,
  stripDefaults,
  SETTINGS_ATOMIC_PATHS,
  type AppSettings,
  type ResolvedToolRow,
  type SettingsPayload
} from '../../shared/settings'

export class SettingsService {
  private store: JsonFileStore
  private settings: AppSettings
  private error: string | null = null
  private listeners = new Set<() => void>()
  private unwatch: () => void

  constructor(
    private argusHome: string,
    private opts: { argusHomeFromEnv?: boolean; resolvedTools?: () => ResolvedToolRow[] } = {
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
    this.store.write(
      stripDefaults(this.settings, defaultSettings(), { atomicPaths: SETTINGS_ATOMIC_PATHS })
    )
    this.error = null // an explicit save replaces a previously broken file
    this.notify()
    return this.settings
  }

  payload(): SettingsPayload {
    return {
      settings: this.settings,
      resolvedTools: this.opts.resolvedTools?.() ?? [],
      dataRoot: { path: this.argusHome, fromEnv: Boolean(this.opts.argusHomeFromEnv) },
      loadError: this.error
    }
  }

  close(): void {
    this.unwatch()
    this.store.close()
  }
}
