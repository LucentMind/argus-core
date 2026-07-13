import type { ExternalAppInfo } from '../../../shared/panels'

export interface ExternalAppsState {
  caseSlug: string | null
  apps: ExternalAppInfo[]
}

export class ExternalAppsStore {
  private state: ExternalAppsState = { caseSlug: null, apps: [] }
  private listeners = new Set<() => void>()

  get(): ExternalAppsState {
    return this.state
  }
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  private set(patch: Partial<ExternalAppsState>): void {
    this.state = { ...this.state, ...patch }
    for (const cb of this.listeners) cb()
  }
  setCase(slug: string): void {
    if (this.state.caseSlug === slug) return
    this.set({ caseSlug: slug, apps: [] })
  }
  setApps(apps: ExternalAppInfo[]): void {
    this.set({ apps })
  }
}

export const externalAppsStore = new ExternalAppsStore()

/**
 * Wire the singleton to Core for a case: hydrate the running/exited app list,
 * and re-list on the panels:changed broadcast (reused for external apps too).
 * Returns an unsubscribe for effect cleanup.
 */
export function wireExternalAppsStore(slug: string): () => void {
  externalAppsStore.setCase(slug)
  if (!window.argus?.externalApps) return () => {}

  // guard against a slow list() from a previous case resolving after a newer
  // setCase, writing stale data over the current case's state
  let stale = false
  const resync = (): void => {
    void window.argus.externalApps.list(slug).then(
      (list) => {
        if (!stale) externalAppsStore.setApps(list)
      },
      () => {
        if (!stale) externalAppsStore.setApps([])
      }
    )
  }
  resync()
  const off = window.argus.panels.onChanged(resync)
  return () => {
    stale = true
    off()
  }
}
