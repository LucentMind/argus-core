import { JsonFileStore } from './fileStore'
import { presetsPath } from './paths'
import { deepMerge } from '../../shared/settings'
import { DEFAULT_PRESETS, presetsSchema, type ConnectorPresets } from '../../shared/connectors'

/** Guard for shell.openExternal: only http(s) URLs are openable (blocks javascript:, file:, etc). */
export function isOpenableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** Optional, preconfigurable connector presets. Loaded once at startup; restart to pick up edits. */
export function loadPresets(argusHome: string): ConnectorPresets {
  const store = new JsonFileStore(presetsPath(argusHome))
  const { data, error } = store.load()
  store.close()
  if (error) console.warn(`connector-presets.json ignored: ${error}`)
  const r = presetsSchema.safeParse(deepMerge(DEFAULT_PRESETS, data ?? {}))
  if (!r.success) {
    console.warn(`connector-presets.json ignored: ${r.error.message}`)
    return DEFAULT_PRESETS
  }
  return r.data
}
