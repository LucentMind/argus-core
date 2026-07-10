import { JsonFileStore } from './fileStore'
import { mcpServersPath } from './paths'
import { deepMerge } from '../../shared/settings'
import { connectorsSchema, type ConnectorMap, type DiscoveredTool } from '../../shared/connectors'

/**
 * Watched registry over config/mcp-servers.json. Unlike settings.json the file
 * is written whole (every entry is user content — nothing to strip); patch
 * semantics still deep-merge, with null deleting an instance or config key.
 */
export class ConnectorRegistry {
  private store: JsonFileStore
  private map: ConnectorMap
  private error: string | null = null
  private listeners = new Set<() => void>()
  private unwatch: () => void

  constructor(argusHome: string) {
    this.store = new JsonFileStore(mcpServersPath(argusHome))
    this.map = this.loadNow()
    this.unwatch = this.store.watch(() => {
      this.map = this.loadNow()
      this.notify()
    })
  }

  private loadNow(): ConnectorMap {
    const { data, error } = this.store.load()
    this.error = error
    const r = connectorsSchema.safeParse(data)
    if (r.success) return r.data
    this.error = this.error ?? r.error.message
    return {}
  }

  private notify(): void {
    for (const cb of this.listeners) cb()
  }

  get(): ConnectorMap {
    return this.map
  }

  loadError(): string | null {
    return this.error
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  patch(partial: unknown): ConnectorMap {
    this.map = connectorsSchema.parse(deepMerge(this.map, partial))
    this.store.write(this.map)
    this.error = null // an explicit save replaces a previously broken file
    this.notify()
    return this.map
  }

  /** Cache a discovery result on the entry (spec §2.5) so the UI renders tools without reconnecting. */
  setDiscovered(instanceId: string, tools: DiscoveredTool[]): void {
    if (!this.map[instanceId]) return
    this.patch({ [instanceId]: { lastDiscovered: { at: new Date().toISOString(), tools } } })
  }

  close(): void {
    this.unwatch()
    this.store.close()
  }
}
