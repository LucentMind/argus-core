import { JsonFileStore } from '../fileStore'
import { routinesPath } from '../paths'
import {
  routineSchema,
  routinesFileSchema,
  defaultRoutines,
  type RoutineDef,
  type RoutinesFile
} from '../../../shared/routines'

/**
 * Watched store over config/routines.json — same machinery and broken-file idiom as
 * ReferenceSyncStore: parse failure keeps the app on in-memory defaults + loadError; an
 * explicit save replaces the broken file.
 */
export class RoutineStore {
  private store: JsonFileStore
  private file: RoutinesFile
  private error: string | null = null
  private listeners = new Set<() => void>()
  private unwatch: () => void

  constructor(argusHome: string) {
    this.store = new JsonFileStore(routinesPath(argusHome))
    this.file = this.loadNow()
    this.unwatch = this.store.watch(() => {
      this.file = this.loadNow()
      this.notify()
    })
  }

  private loadNow(): RoutinesFile {
    const { data, error } = this.store.load()
    this.error = error
    const r = routinesFileSchema.safeParse(data)
    if (r.success) return r.data
    this.error = this.error ?? r.error.message
    return defaultRoutines()
  }

  list(): RoutineDef[] {
    return this.file.routines
  }

  get(id: string): RoutineDef | undefined {
    return this.file.routines.find((r) => r.id === id)
  }

  loadError(): string | null {
    return this.error
  }

  upsert(routine: unknown): RoutineDef {
    const parsed = routineSchema.parse(routine)
    const routines = [...this.file.routines.filter((r) => r.id !== parsed.id), parsed]
    this.save({ ...this.file, routines })
    return parsed
  }

  remove(id: string): void {
    this.save({ ...this.file, routines: this.file.routines.filter((r) => r.id !== id) })
  }

  private save(next: RoutinesFile): void {
    const parsed = routinesFileSchema.parse(next)
    // Write BEFORE adopting: if the write throws, nothing has changed, so the store, the file
    // on disk and the in-memory state all still agree — never live state that no file records.
    this.store.write(parsed)
    this.file = parsed
    this.error = null // an explicit save replaces a previously broken file
    this.notify()
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
