/**
 * The ONE answer to "does this model string name this catalog row?".
 *
 * Why it has to be shared: the Claude CLI's runtime catalog keys its rows by ALIAS
 * (`default`, `opus[1m]`, `fable`, `sonnet`, `haiku`) and reports the wire slug separately as
 * `resolvedModel` (`claude-opus-5[1m]`, `claude-fable-5`, …) — there is no `claude-*` string
 * in any `value`. Argus, meanwhile, pins a session by WIRE SLUG (`sessions.model`, seeded
 * from the static `CLAUDE_MODELS` list in `drivers.ts`). Matching a pinned slug against
 * `value` alone therefore never hits.
 *
 * Before this module the renderer and the main process each implemented that match
 * independently, and they disagreed: `Composer.tsx` fell through to `models[0]` (so every
 * chat's model chip read "Default (recommended)" regardless of its real model), while
 * `drivers/claude/catalog.ts` resolved a different row — or none, in which case
 * `queryOptions.ts` built `ds = []` and dropped every run option off the wire while the
 * composer still offered the full option set. Both now call in here, so they cannot drift
 * apart again.
 */

/** The identity fields a model row can be matched by, from either kind of source. */
export interface ModelIdentity {
  /** The row's own key: a CLI alias on a runtime catalog, a wire slug on a static one. */
  value: string
  /** The wire slug that alias resolves to, when the source reports one. */
  resolvedModel?: string
}

/** Drops the 1M-context slug suffix. `apiModelId` (shared/runOptions.ts) is what adds it, so
 *  a session pinned at the suffix must still find its base row's capabilities. */
function bare(slug: string): string {
  return slug.replace(/\[1m\]$/, '')
}

/**
 * True when `resolved` IS `id`, or `id` with a trailing `-YYYYMMDD` date segment appended —
 * the shape the Claude CLI catalog uses for dated model ids (`claude-haiku-4-5-20251001`)
 * against Argus's static, undated slug (`claude-haiku-4-5`).
 *
 * Deliberately narrow: only an exact 8-digit date suffix counts, so `claude-opus-4` still does
 * NOT match `claude-opus-4-8` — that was the collision a naive prefix rule would cause, and is
 * why this stays a dedicated date-suffix check rather than `resolved.startsWith(id)`.
 *
 * Exported (not just inlined into `modelMatches`) so custom-model dedupe (`shared/drivers.ts`)
 * can reuse the date-suffix rule WITHOUT also pulling in `bare()`'s `[1m]` stripping — that
 * stripping is right for matching a pinned session against its row, but wrong for dedupe, where
 * an explicit `claude-sonnet-5[1m]` custom model must stay distinct from `claude-sonnet-5`.
 */
export function resolvesToId(resolved: string, id: string): boolean {
  if (resolved === id) return true
  if (!resolved.startsWith(id)) return false
  return /^-\d{8}$/.test(resolved.slice(id.length))
}

/**
 * True when `model` names this row — by `value`, by `resolvedModel`, or by either with a
 * trailing `[1m]` stripped from BOTH sides, or by `resolvedModel` carrying a `-YYYYMMDD` date
 * segment the stored id lacks (see {@link resolvesToId}). That union is exactly what the
 * renderer and the main process used to attempt separately.
 *
 * `claude-haiku-4-5` DOES match a `resolvedModel` of `claude-haiku-4-5-20251001` (date-suffix
 * rule); `claude-opus-4` still does NOT match `claude-opus-4-8` (no row resolves to that via an
 * exact date suffix, and a bare prefix rule is deliberately not what this is).
 */
export function modelMatches(row: ModelIdentity, model: string): boolean {
  const wanted = bare(model)
  if (row.value === model || bare(row.value) === wanted) return true
  const rm = row.resolvedModel
  if (rm === undefined) return false
  return resolvesToId(rm, model) || resolvesToId(bare(rm), wanted)
}

/**
 * The row `model` names, or null. `value` matches win over `resolvedModel` matches (the
 * alias is the row's own identity, and two alias rows can share one `resolvedModel` — the
 * fixture's `default` and `opus[1m]` both resolve to `claude-opus-5[1m]`).
 *
 * `identityOf` exists because the two sources spell the same fields differently:
 * `ModelOptionInfo` already IS a `ModelIdentity`, while a picker row (`CatalogModel`) calls
 * the key `slug`.
 */
export function findModelEntry<T>(
  rows: readonly T[],
  model: string | null | undefined,
  identityOf: (row: T) => ModelIdentity
): T | null {
  if (!model) return null
  const wanted = bare(model)
  const byValue = rows.find((r) => {
    const v = identityOf(r).value
    return v === model || bare(v) === wanted
  })
  if (byValue !== undefined) return byValue
  const byResolved = rows.find((r) => {
    const rm = identityOf(r).resolvedModel
    return rm !== undefined && (resolvesToId(rm, model) || resolvesToId(bare(rm), wanted))
  })
  return byResolved ?? null
}
