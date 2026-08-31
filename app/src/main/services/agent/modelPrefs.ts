import {
  canonicalizePreferences,
  catalogModelRows,
  enabledInstances,
  hasUnresolvedPreferences
} from '../../../shared/drivers'
import type { AppSettings, ModelPreferences } from '../../../shared/settings'
import type { ModelOptionInfo } from '../../../shared/runOptions'

/** The slice of `SettingsService` this needs — DI, so the migration is testable without an
 *  Electron app or a settings file on disk. */
export interface ModelPrefsSettings {
  get(): AppSettings
  patch(partial: unknown): unknown
}

const LISTS = ['hiddenModels', 'favoriteModels', 'modelOrder'] as const

function sameLists(a: ModelPreferences, b: ModelPreferences): boolean {
  return LISTS.every((k) => a[k].length === b[k].length && a[k].every((s, i) => s === b[k][i]))
}

/**
 * Migrate one instance's stored model preferences to canonical wire slugs, using a catalog
 * that has just been fetched. Returns whether it wrote.
 *
 * Why it lives on the catalog fetch rather than in `SettingsService.loadNow` with the rest of
 * the schema migrations: an alias is only interpretable against the catalog that minted it.
 * `opus[1m]` does not mean "Opus 5" by inspection — it means whatever THIS CLI version resolves
 * it to, and settings load long before any CLI has been spawned. Migrating there would mean
 * hard-coding an alias table that is wrong by construction (`opus` names a different model
 * every time Anthropic ships one). Doing it here costs one delayed launch — a case created in
 * the seconds before the composer's first catalog fetch still gets the old seed — and in
 * exchange the rewrite is exact, and self-heals for aliases that do not exist yet.
 *
 * Safe to call on every fetch, which is what makes that placement workable: it writes only when
 * the canonical form actually differs, and `canonicalizePreferences` keeps slugs it cannot
 * resolve rather than dropping them — so a fallback or empty catalog (offline, missing CLI) is
 * a no-op, not a silent reset of the user's favourites.
 */
export function canonicalizeStoredModelPrefs(
  settings: ModelPrefsSettings,
  instanceId: string,
  catalog: readonly ModelOptionInfo[]
): boolean {
  const stored = settings.get().agent.modelPreferences[instanceId]
  if (!stored) return false
  const next = canonicalizePreferences(catalogModelRows(catalog), stored)
  if (sameLists(stored, next)) return false
  settings.patch({ agent: { modelPreferences: { [instanceId]: next } } })
  return true
}

/**
 * Migrate every enabled Claude instance's stored model preferences at boot.
 *
 * Fire-and-forget: it awaits nothing the app needs, and a CLI that is missing or slow degrades
 * to "not migrated this launch" rather than an unhandled rejection.
 *
 * Boot, rather than the composer's catalog fetch, because the seed runs FIRST. A new case is
 * pinned by `defaultModelRef` at creation and the composer only mounts afterwards, so a
 * migration hanging off that fetch would let one more case be seeded from the stale prefs —
 * which is precisely the flow that produced the report. `hasUnresolvedPreferences` keeps the
 * cost at zero for anyone with nothing stale: no unresolvable slug, no catalog fetch, no spawn.
 * The fetch is cached process-wide, so for anyone who does need it this is the same fetch the
 * composer would have made moments later, just earlier.
 */
export async function migrateModelPrefs(
  settings: ModelPrefsSettings,
  fetchCatalog: (instanceId: string) => Promise<readonly ModelOptionInfo[]>
): Promise<void> {
  for (const { id, driver } of enabledInstances(settings.get())) {
    if (driver.kind !== 'claude-agent-sdk') continue
    if (!hasUnresolvedPreferences(settings.get(), id)) continue
    try {
      canonicalizeStoredModelPrefs(settings, id, await fetchCatalog(id))
    } catch (err) {
      console.warn(`[modelPrefs] catalog fetch failed for ${id}; preferences left as stored`, err)
    }
  }
}
