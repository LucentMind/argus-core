import path from 'node:path'
import { JsonFileStore } from './fileStore'
import { configDir } from './paths'
import type { WindowBounds } from '../../shared/editorIpc'

function isBounds(v: unknown): v is WindowBounds {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (['x', 'y', 'width', 'height'] as const).every((k) => Number.isFinite(r[k]))
}

/**
 * Volatile editor-window UI state. Deliberately not `settings.json`: that file is schema'd,
 * user-editable config run through `stripDefaults`, and Increment 4 adds the open tab set here,
 * which is session state rather than configuration.
 */
export class EditorWindowStore {
  private store: JsonFileStore

  constructor(argusHome: string) {
    this.store = new JsonFileStore(path.join(configDir(argusHome), 'editor-window.json'))
  }

  load(): WindowBounds | null {
    const { data } = this.store.load()
    const bounds = (data as { bounds?: unknown } | null)?.bounds
    return isBounds(bounds) ? bounds : null
  }

  save(bounds: WindowBounds): void {
    this.store.write({ bounds })
  }
}
