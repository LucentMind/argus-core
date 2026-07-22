import { useEffect, useSyncExternalStore } from 'react'
import type { ProposalCounts } from '../../../shared/proposals'

/**
 * Renderer mirror of the pending-proposal counts. Primed from proposals.list()
 * on first use, then kept live by the proposals:changed broadcast — the sidebar
 * badge and per-page banners read from here without refetching.
 */
export class ProposalsStore {
  private counts: ProposalCounts | null = null
  private listeners = new Set<() => void>()
  private started = false

  /** Idempotent: first call fetches the list and subscribes to proposals:changed. */
  start(): void {
    if (this.started) return
    this.started = true
    void window.argus.proposals
      .list()
      .then((p) => {
        const byType: ProposalCounts['byType'] = {}
        for (const r of p.proposals) {
          byType[r.type] = (byType[r.type] ?? 0) + 1
        }
        this.set({ pendingCount: p.proposals.length, byType })
      })
      .catch((e) => {
        // priming is best-effort (the badge just stays empty), but a dead IPC
        // channel should at least leave a trace in the console
        console.warn('proposalsStore: priming from proposals.list() failed', e)
      })
    window.argus.proposals.onChanged((c) => this.set(c))
  }

  /** Test-only escape hatch: forces the next start() to refetch against a fresh mock. */
  reset(): void {
    this.started = false
    this.counts = null
  }

  private set(c: ProposalCounts): void {
    this.counts = c
    for (const cb of this.listeners) cb()
  }

  get(): ProposalCounts | null {
    return this.counts
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}

export const proposalsStore = new ProposalsStore()

export function useProposalCounts(): ProposalCounts | null {
  useEffect(() => {
    proposalsStore.start()
  }, [])
  return useSyncExternalStore(
    (cb) => proposalsStore.subscribe(cb),
    () => proposalsStore.get()
  )
}
