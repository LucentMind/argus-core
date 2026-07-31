import { JsonFileStore } from '../fileStore'
import { packsStatePath } from '../paths'

/**
 * Where an installed pack's updates may come from — the trust-on-first-use pin (spec §6).
 * Stored in a map parallel to `packs` rather than by widening `packs` itself, so a state file
 * written before this existed reads unchanged and there is no migration.
 */
export interface PackSource {
  /** Scheme + host + port of the feed, e.g. 'https://vendor.example'. Downloads must match. */
  origin: string
  /** The full feed URL exactly as recorded at install time. Fetched verbatim; never rebuilt. */
  updateUrl: string
  installedAt: number
}

interface PacksStateFile {
  packs: Record<string, string> // id -> version
  sources: Record<string, PackSource> // id -> pin (absent for packs with no updateUrl)
}

export class PacksStateStore {
  private store: JsonFileStore

  constructor(argusHome: string) {
    this.store = new JsonFileStore(packsStatePath(argusHome))
  }

  private read(): PacksStateFile {
    const { data } = this.store.load()
    const raw = (data ?? {}) as Partial<PacksStateFile>
    return {
      packs: raw.packs && typeof raw.packs === 'object' ? { ...raw.packs } : {},
      sources: raw.sources && typeof raw.sources === 'object' ? { ...raw.sources } : {}
    }
  }

  list(): Record<string, string> {
    return this.read().packs
  }

  get(id: string): string | undefined {
    return this.read().packs[id]
  }

  set(id: string, version: string): void {
    const state = this.read()
    state.packs[id] = version
    this.store.write(state)
  }

  remove(id: string): void {
    const state = this.read()
    delete state.packs[id]
    delete state.sources[id]
    this.store.write(state)
  }

  listSources(): Record<string, PackSource> {
    return this.read().sources
  }

  getSource(id: string): PackSource | undefined {
    return this.read().sources[id]
  }

  /** Record the pin, or pass `null` to clear it (a manifest that declares no updateUrl). */
  setSource(id: string, source: PackSource | null): void {
    const state = this.read()
    if (source) state.sources[id] = source
    else delete state.sources[id]
    this.store.write(state)
  }

  close(): void {
    this.store.close()
  }
}
