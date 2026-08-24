import { declineKey } from '../../hivemind'

/**
 * The post-success side effects of every manual mutation that can resolve or remove a held-back
 * item. `CurrencyService.blocked` is otherwise rewritten only by a survey, so without these a hold
 * the user just resolved by hand keeps its badge, its nav dot and its reason line for up to six
 * hours — and an uninstalled item keeps counting toward a badge with no row left to explain it.
 *
 * These live here rather than inline in `main/index.ts` because each one passes a key that must
 * match what its adapter emits — the bare pack id for packs, `declineKey(kind, name)` for hive —
 * and a near-miss silently no-ops with a fully green suite. `main/index.ts` has no test harness;
 * this does.
 *
 * Stateless by construction: one dependency, no fields.
 */
export interface ForgetHooks {
  packInstalled(id: string): void
  packUninstalled(id: string): void
  packUpdated(id: string): void
  hiveInstalled(kind: 'skill' | 'reference', name: string): void
  hiveUninstalled(kind: 'skill' | 'reference', name: string): void
}

export function createForgetHooks(deps: { forget: (key: string) => void }): ForgetHooks {
  // `Candidate.key` for a pack is the bare pack id — see `packsAdapter.ts`'s `key: id`.
  const pack = (id: string): void => deps.forget(id)
  // `Candidate.key` for a hive item is `declineKey(kind, name)` — see `hiveAdapter.ts`'s survey().
  const hive = (kind: 'skill' | 'reference', name: string): void =>
    deps.forget(declineKey(kind, name))

  return {
    packInstalled: pack,
    packUninstalled: pack,
    packUpdated: pack,
    hiveInstalled: hive,
    hiveUninstalled: hive
  }
}
