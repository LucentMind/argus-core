import { JsonFileStore } from '../fileStore'
import { packsStatePath } from '../paths'

interface PacksStateFile {
  packs: Record<string, string> // id -> version
}

export class PacksStateStore {
  private store: JsonFileStore

  constructor(argusHome: string) {
    this.store = new JsonFileStore(packsStatePath(argusHome))
  }

  private read(): PacksStateFile {
    const { data } = this.store.load()
    const raw = (data ?? {}) as Partial<PacksStateFile>
    return { packs: raw.packs && typeof raw.packs === 'object' ? { ...raw.packs } : {} }
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
    this.store.write(state)
  }

  close(): void {
    this.store.close()
  }
}
