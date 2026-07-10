import { JsonFileStore } from './fileStore'
import { agentAccessPath } from './paths'
import {
  agentAccessSchema,
  defaultAgentAccess,
  type AgentAccess,
  type AgentAccessPayload
} from '../../shared/agentAccess'
import { deepMerge } from '../../shared/settings'

export class AgentAccessStore {
  private store: JsonFileStore
  private access: AgentAccess
  private error: string | null = null
  private listeners = new Set<() => void>()
  private unwatch: () => void

  constructor(argusHome: string) {
    this.store = new JsonFileStore(agentAccessPath(argusHome))
    this.access = this.loadNow()
    this.unwatch = this.store.watch(() => {
      this.access = this.loadNow()
      this.notify()
    })
  }

  private loadNow(): AgentAccess {
    const { data, error } = this.store.load()
    this.error = error
    const r = agentAccessSchema.safeParse(data)
    if (r.success) return r.data
    this.error = this.error ?? r.error.message
    return defaultAgentAccess()
  }

  /** Drop value===true entries: absent means enabled, so true is the default. */
  private sparse(a: AgentAccess): AgentAccess {
    const drop = (r: Record<string, boolean>): Record<string, boolean> =>
      Object.fromEntries(Object.entries(r).filter(([, v]) => v === false))
    return { ...a, skills: drop(a.skills), memory: drop(a.memory) }
  }

  get(): AgentAccess {
    return this.access
  }

  payload(): AgentAccessPayload {
    return { access: this.access, loadError: this.error }
  }

  patch(partial: unknown): AgentAccess {
    this.access = agentAccessSchema.parse(deepMerge(this.access, partial))
    this.store.write(this.sparse(this.access))
    this.error = null // an explicit save replaces a previously broken file
    this.notify()
    return this.access
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
