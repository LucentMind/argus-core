/**
 * Which generation a Claude model belongs to, so the picker can tell a current model from an
 * outdated one without a hand-maintained deprecation list.
 *
 * `supportedModels()` cannot answer that: it is the CLI's recommended-alias menu, not the set of
 * models that run (see `CLAUDE_MODEL_SPECS`), so "absent from the catalog" does not mean
 * "retired". What the catalog and the static list together DO give us is every version we know
 * of per family, and "the newest few of each family" is the rule the picker applies.
 */

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable'

export interface ParsedModel {
  family: ModelFamily
  /** `claude-opus-5-5` → `[5, 5]`; `claude-opus-5` → `[5]`. */
  version: number[]
}

/** The minimum a row needs to be ranked. `CatalogModel` satisfies it structurally. */
export interface FamilyRow {
  slug: string
  resolvedModel?: string
  isCustom?: boolean
}

/** A wire slug without the two suffixes that do not name a different model: `[1m]` (a context
 *  window, added by `apiModelId`) and the CLI's `-YYYYMMDD` build date. */
export function normalizeModelKey(id: string): string {
  return id.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '')
}

const CLAUDE_SLUG = /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*)$/

/** Family and version of a wire slug; null for an alias (`opus[1m]`), a custom id, another
 *  provider's model, or the pre-4 naming (`claude-3-5-sonnet-…`). */
export function parseClaudeModel(id: string): ParsedModel | null {
  const m = CLAUDE_SLUG.exec(normalizeModelKey(id))
  if (!m) return null
  return { family: m[1] as ModelFamily, version: m[2].split('-').map(Number) }
}

/** Part-by-part version comparison, a missing part counting as 0 (`5.5 > 5`, `5 == 5.0`). */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The wire slug a row stands for: a runtime-catalog row's `resolvedModel`, else its own slug
 *  (static and custom rows, whose slug already is the wire slug). */
function rowKey(row: FamilyRow): string {
  return normalizeModelKey(row.resolvedModel ?? row.slug)
}

/**
 * Normalized wire slugs that are outdated: for each family, everything beyond the newest
 * `keepPerFamily` distinct versions among `rows`.
 *
 * Custom rows are neither ranked nor flagged. They are hand-typed, so they must not push a
 * built-in out of the picker, and the user asked for them, so they must not be hidden either.
 * Rows that do not parse (aliases like `default`, other providers' models) are skipped for the
 * same reason: nothing is known about their generation.
 */
export function legacyModelKeys(rows: readonly FamilyRow[], keepPerFamily = 2): Set<string> {
  const byFamily = new Map<ModelFamily, Map<string, number[]>>()
  for (const row of rows) {
    if (row.isCustom) continue
    const key = rowKey(row)
    const parsed = parseClaudeModel(key)
    if (!parsed) continue
    const versions = byFamily.get(parsed.family) ?? new Map<string, number[]>()
    versions.set(key, parsed.version)
    byFamily.set(parsed.family, versions)
  }
  const legacy = new Set<string>()
  for (const versions of byFamily.values()) {
    const newestFirst = [...versions.entries()].sort(([, a], [, b]) => compareVersions(b, a))
    for (const [key] of newestFirst.slice(keepPerFamily)) legacy.add(key)
  }
  return legacy
}

/** True when `row` names one of `legacy`. Custom rows never do (see {@link legacyModelKeys}). */
export function isLegacyRow(row: FamilyRow, legacy: ReadonlySet<string>): boolean {
  return !row.isCustom && legacy.has(rowKey(row))
}

/** Families in picker order. Fable sits above Sonnet, as the static list has always had it. */
const FAMILY_ORDER: readonly ModelFamily[] = ['opus', 'fable', 'sonnet', 'haiku']

/**
 * The rows grouped by family and, inside a family, newest version first — a stable sort of the
 * rows that parse, written back into the SAME slots. Rows that do not parse (custom models,
 * other providers' ids) therefore stay where they were: nothing is known about where they
 * belong, and moving them would be inventing a ranking.
 *
 * It exists because the runtime catalog's rows lead the merged list and the static built-ins
 * trail it (see `mergeBuiltinRows`), which interleaved generations — Opus 5, Sonnet 5, Fable
 * 5.1, Haiku 4.5, Fable 5, Opus 4.8… — in whatever order the two sources happened to produce.
 */
export function sortByFamily<T extends FamilyRow>(rows: readonly T[]): T[] {
  const slots: number[] = []
  const placed: Array<{ row: T; parsed: ParsedModel; index: number }> = []
  rows.forEach((row, index) => {
    const parsed = row.isCustom ? null : parseClaudeModel(row.resolvedModel ?? row.slug)
    if (!parsed) return
    slots.push(index)
    placed.push({ row, parsed, index })
  })
  placed.sort(
    (a, b) =>
      FAMILY_ORDER.indexOf(a.parsed.family) - FAMILY_ORDER.indexOf(b.parsed.family) ||
      compareVersions(b.parsed.version, a.parsed.version) ||
      a.index - b.index
  )
  const out = [...rows]
  slots.forEach((slot, i) => {
    out[slot] = placed[i].row
  })
  return out
}
