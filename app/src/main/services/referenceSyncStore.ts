import { JsonFileStore } from './fileStore'
import { refSyncPath, refSyncStatePath } from './paths'
import {
  referenceSyncSchema,
  spaceConfigSchema,
  defaultReferenceSync,
  type ReferenceSyncConfig,
  type RefSyncState
} from '../../shared/referenceSync'

/**
 * Watched store over config/reference-sync.json (spec §3.3) — same machinery
 * and broken-file idiom as AgentAccessStore: parse failure keeps the app on
 * in-memory defaults + a banner; an explicit save replaces the broken file.
 */
export class ReferenceSyncStore {
  private store: JsonFileStore
  private config: ReferenceSyncConfig
  private error: string | null = null
  private listeners = new Set<() => void>()
  private unwatch: () => void

  constructor(argusHome: string) {
    this.store = new JsonFileStore(refSyncPath(argusHome))
    this.config = this.loadNow()
    this.unwatch = this.store.watch(() => {
      this.config = this.loadNow()
      this.notify()
    })
  }

  private loadNow(): ReferenceSyncConfig {
    const { data, error } = this.store.load()
    this.error = error
    const r = referenceSyncSchema.safeParse(data)
    if (r.success) return r.data
    this.error = this.error ?? r.error.message
    return defaultReferenceSync()
  }

  get(): ReferenceSyncConfig {
    return this.config
  }

  loadError(): string | null {
    return this.error
  }

  upsertSpace(space: unknown): ReferenceSyncConfig {
    const parsed = spaceConfigSchema.parse(space)
    const spaces = [...this.config.spaces.filter((s) => s.key !== parsed.key), parsed]
    return this.save({ ...this.config, spaces })
  }

  removeSpace(key: string): ReferenceSyncConfig {
    return this.save({ ...this.config, spaces: this.config.spaces.filter((s) => s.key !== key) })
  }

  setOutdatedWindow(months: number): ReferenceSyncConfig {
    return this.save({ ...this.config, outdatedWindowMonths: months })
  }

  setMustKeep(target: string, patterns: string[]): ReferenceSyncConfig {
    return this.save({ ...this.config, mustKeep: { ...this.config.mustKeep, [target]: patterns } })
  }

  private save(next: ReferenceSyncConfig): ReferenceSyncConfig {
    this.config = referenceSyncSchema.parse(next)
    this.store.write(this.config)
    this.error = null // an explicit save replaces a previously broken file
    this.notify()
    return this.config
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    for (const cb of this.listeners) cb()
  }

  close(): void {
    this.unwatch()
    this.store.close()
    this.listeners.clear()
  }
}

// — machine state; not watched, not user-facing —

export function readSyncState(argusHome: string): RefSyncState {
  const { data } = new JsonFileStore(refSyncStatePath(argusHome)).load()
  const d = data as Partial<RefSyncState>
  return { spaces: d.spaces ?? {} }
}

export function writeSyncState(argusHome: string, state: RefSyncState): void {
  new JsonFileStore(refSyncStatePath(argusHome)).write(state)
}
