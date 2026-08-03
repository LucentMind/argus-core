import { JsonFileStore } from '../fileStore'
import { packsStatePath } from '../paths'

/**
 * A pack pinned to a vendor-hosted static feed. `kind` is OPTIONAL and absent on every pin
 * written before the union existed, so a state file from PR #41 reads unchanged and there is
 * still no migration.
 */
export interface FeedPackSource {
  kind?: 'feed'
  /** Scheme + host + port of the feed, e.g. 'https://vendor.example'. Downloads must match. */
  origin: string
  /** The full feed URL exactly as recorded at install time. Fetched verbatim; never rebuilt. */
  updateUrl: string
  installedAt: number
}

/**
 * A pack pinned to a GitHub repository whose Releases publish it. The anchor is host + owner +
 * repo; the hazard it must survive is a repo RENAME OR TRANSFER, which GitHub forwards silently
 * (see `githubFeed.ts`).
 */
export interface GithubPackSource {
  kind: 'github'
  host: string
  owner: string
  repo: string
  /**
   * Repo-relative path of this pack's `argus-pack.json`, when it is known — a hint that saves a
   * tree lookup, not a guarantee. Optional because a manifest-declared `updateRepo` cannot know
   * where in its own repo it will sit, and stale because a pack may be moved within its repo.
   * `githubFeed.ts` falls back to a tree search whenever the hint misses.
   */
  manifestPath?: string
  installedAt: number
}

export type PackSource = FeedPackSource | GithubPackSource

export function isGithubSource(source: PackSource): source is GithubPackSource {
  return source.kind === 'github'
}

interface PacksStateFile {
  packs: Record<string, string> // id -> version
  sources: Record<string, PackSource> // id -> pin (absent for packs with no update source)
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
