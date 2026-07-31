import path from 'node:path'
import { JsonFileStore } from './fileStore'
import { configDir } from './paths'
import type { PersistedTab, PersistedTabs, WindowBounds } from '../../shared/editorIpc'

function isBounds(v: unknown): v is WindowBounds {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (['x', 'y', 'width', 'height'] as const).every((k) => Number.isFinite(r[k]))
}

function isTab(v: unknown): v is PersistedTab {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (r.kind !== 'skill' && r.kind !== 'reference') return false
  if (typeof r.name !== 'string' || r.name === '') return false
  if (r.mode !== 'edit' && r.mode !== 'create') return false
  if (r.view === null || r.view === undefined) return true
  const v2 = r.view as Record<string, unknown>
  return ['line', 'col', 'scrollFraction'].every((k) => Number.isFinite(v2[k]))
}

function isTabs(v: unknown): v is PersistedTabs {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return Array.isArray(r.tabs) && r.tabs.every(isTab) && Number.isFinite(r.activeIndex)
}

/**
 * Volatile editor-window UI state. Deliberately not `settings.json`: that file is schema'd,
 * user-editable config run through `stripDefaults`, and the open tab set is session state
 * rather than configuration.
 *
 * Bounds and tabs share one file and are written independently, so each writer must merge
 * rather than replace — `JsonFileStore.write` takes the whole document.
 */
export class EditorWindowStore {
  private store: JsonFileStore

  constructor(argusHome: string) {
    this.store = new JsonFileStore(path.join(configDir(argusHome), 'editor-window.json'))
  }

  private doc(): Record<string, unknown> {
    const { data } = this.store.load()
    return typeof data === 'object' && data !== null ? { ...(data as Record<string, unknown>) } : {}
  }

  load(): WindowBounds | null {
    const bounds = this.doc().bounds
    return isBounds(bounds) ? bounds : null
  }

  save(bounds: WindowBounds): void {
    this.store.write({ ...this.doc(), bounds })
  }

  /** Null when absent or malformed — a hand-edited file must not stop the window opening. */
  loadTabs(): PersistedTabs | null {
    const tabs = this.doc().tabs
    return isTabs(tabs) ? tabs : null
  }

  saveTabs(tabs: PersistedTabs): void {
    this.store.write({ ...this.doc(), tabs })
  }
}
