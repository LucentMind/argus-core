import type { Candidate, CurrencyDomain, CurrencyPayload } from '../../../shared/currency'
import { surfacedBlocked } from '../../../shared/currency'
import type { PageId } from '../components/settings/settingsPages'

/**
 * The Settings pages that can own a held-back item — DERIVED from the real `PAGES` table
 * (`settingsPages.ts`), not hand-written independently of it. Three copies of the same
 * assumption used to exist: this literal union, `SettingsView.tsx`'s `p.id as SettingsPageId`
 * cast, and `pageOwning`'s catch-all below — with nothing tying them together. Renaming or
 * removing one of `'general' | 'sources' | 'team'` in `PAGES` now silently drops it from
 * `Extract`'s result instead, which turns `pageOwning`'s corresponding `return` literal (below)
 * into a compile error rather than a badge that quietly stops finding its page.
 */
export type SettingsPageId = Extract<PageId, 'general' | 'sources' | 'team'>

/**
 * Which Settings page shows a given domain — `general` hosts `<UpdateSettings/>`, `sources` hosts
 * `<PacksSettings/>`, `team` hosts `<HivemindSettings/>`. Spelled once here so a badge and the
 * row it is meant to lead to can never disagree about where the item lives.
 *
 * Written as an exhaustive switch with NO default — same idiom as `describeBlocked` in
 * `shared/currency.ts` — rather than the previous `if/if/else` catch-all: the compiler proves
 * every `CurrencyDomain` is covered by narrowing the switch to `never` on the way out, so a fifth
 * domain added to that union without a case here fails `typecheck` ("not all code paths return a
 * value") instead of silently falling through to `'team'`.
 */
export function pageOwning(domain: CurrencyDomain): SettingsPageId {
  switch (domain) {
    case 'core':
      return 'general'
    case 'pack':
      return 'sources'
    case 'hive-skill':
    case 'hive-reference':
      return 'team'
  }
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
   *  second IPC listener, which would double every notification.
   *
   *  `onChanged` is registered BEFORE `get()` is awaited, so a broadcast can legitimately arrive
   *  while hydration is still in flight — guarded with `this.state === EMPTY` rather than
   *  unconditionally adopting `get()`'s result, so that broadcast wins instead of being clobbered
   *  by the later-resolving (and by then stale) hydration. `.catch()` on the hydration promise
   *  keeps a rejected `get()` (e.g. main not yet ready) from becoming an unhandled rejection —
   *  the store just stays at `EMPTY` until the next broadcast, rather than every consumer being
   *  left permanently empty with no error surfaced anywhere. */
  start(): void {
    if (this.started) return
    this.started = true
    window.argus.currency.onChanged((p) => this.set(p))
    void window.argus.currency
      .get()
      .then((p) => {
        if (this.state === EMPTY) this.set(p)
      })
      .catch(() => {})
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

/**
 * The "N update(s) need(s) you" phrase shared by the TopBar Settings badge, the Settings nav rows
 * and both section badges. Both the noun and the verb agree with `n` — the Packs page's section
 * badge shipped with only the noun pluralized ("2 updates needs you") and had to be fixed after
 * the fact, so this is centralized to keep that mistake from recurring a third time.
 *
 * Two shapes, because the four call sites genuinely read differently and always have:
 *   `subject`   prefixes "Subject — ", for a control whose name must say what it leads to
 *               (the TopBar button, a nav row).
 *   `qualifier` goes inside the noun ("1 pack update"), for a badge already sitting on the
 *               section it is about, where a subject prefix would just repeat the header.
 * Passing neither yields the bare phrase. Passing both is allowed and yields
 * "Subject — N qualifier updates need you"; no current call site does that.
 */
export function needsYouLabel(
  n: number,
  { subject, qualifier }: { subject?: string; qualifier?: string } = {}
): string {
  const core = `${n} ${qualifier ? `${qualifier} ` : ''}update${n === 1 ? '' : 's'} ${n === 1 ? 'needs' : 'need'} you`
  return subject ? `${subject} — ${core}` : core
}
