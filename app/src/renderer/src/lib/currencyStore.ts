import type { Candidate, CurrencyDomain, CurrencyPayload } from '../../../shared/currency'
import { surfacedBlocked } from '../../../shared/currency'

/** The Settings pages that can own a held-back item. */
export type SettingsPageId = 'general' | 'sources' | 'team'

/**
 * Which Settings page shows a given domain — `general` hosts `<UpdateSettings/>`, `sources` hosts
 * `<PacksSettings/>`, `team` hosts `<HivemindSettings/>`. Spelled once here so a badge and the
 * row it is meant to lead to can never disagree about where the item lives.
 */
export function pageOwning(domain: CurrencyDomain): SettingsPageId {
  if (domain === 'core') return 'general'
  if (domain === 'pack') return 'sources'
  return 'team'
}

const EMPTY: CurrencyPayload = { auto: true, lastSurveyAt: null, blocked: [], busy: false }

/**
 * Currency state, fed by one `currency:changed` broadcast from main. `start()` is idempotent so
 * every consumer (Settings sidebar, Packs page, HiveMind page, TopBar) can call it on mount
 * without racing — modeled on `updateStore`'s shape.
 *
 * `get()` returns the raw payload and is the only thing that should ever be handed to
 * `useSyncExternalStore` as `getSnapshot`: it is referentially stable between notifications: the
 * same object reference until the next `set()`. `blockedByPage()` and `surfacedCount()` are
 * derived on every call — each allocates a fresh object/number — so a consumer must compute them
 * inside the component body from a `useSyncExternalStore(currencyStore.subscribe, currencyStore.get)`
 * snapshot, never pass `blockedByPage` itself as `getSnapshot` (it would never look "equal" to
 * React and would spin the render loop).
 */
class CurrencyStore {
  private state: CurrencyPayload = EMPTY
  private readonly listeners = new Set<() => void>()
  private started = false

  get(): CurrencyPayload {
    return this.state
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  /** Hydrate once and stay subscribed. Idempotent: mounting a second consumer must not attach a
   *  second IPC listener, which would double every notification. */
  start(): void {
    if (this.started) return
    this.started = true
    window.argus.currency.onChanged((p) => this.set(p))
    void window.argus.currency.get().then((p) => this.set(p))
  }

  /** Held-back items grouped by the page that shows them. Always has all three keys, so a
   *  consumer can index without a null check. Derives from `surfacedBlocked` only — never
   *  re-derives which reason kinds are actionable. */
  blockedByPage(): Record<SettingsPageId, Candidate[]> {
    const out: Record<SettingsPageId, Candidate[]> = { general: [], sources: [], team: [] }
    for (const c of surfacedBlocked(this.state.blocked)) out[pageOwning(c.domain)].push(c)
    return out
  }

  /** Total worth showing — what the TopBar dot and the status line count. */
  surfacedCount(): number {
    return surfacedBlocked(this.state.blocked).length
  }

  /** Test-only: the module-level singleton outlives each test's stubbed `window.argus`. Named to
   *  match this suite's usage; see `updateStore.clearForTests()` for the sibling precedent. */
  reset(): void {
    this.state = EMPTY
    this.started = false
    this.listeners.clear()
  }

  private set(p: CurrencyPayload): void {
    this.state = p
    for (const cb of this.listeners) cb()
  }
}

export const currencyStore = new CurrencyStore()
