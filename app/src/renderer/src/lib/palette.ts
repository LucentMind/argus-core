import { fuzzyMatch } from './fuzzy'
import type { Command } from './commands'
import type { CorpusItem } from '../../../shared/corpusSearch'
import type { AuthoringKind } from '../../../shared/authoringIpc'
import type { DraftRecord } from '../../../shared/editorIpc'

/** Spec §6.2 and §6.4 share one overlay; which list it shows is DERIVED from the query rather
 *  than held as a second piece of state, so `>` can switch modes mid-type and backspacing over
 *  it switches back with nothing to keep in sync. */
export type PaletteMode = 'assets' | 'commands'

export function modeFromQuery(raw: string): { mode: PaletteMode; query: string } {
  if (!raw.startsWith('>')) return { mode: 'assets', query: raw }
  // One optional space is eaten so "> save" and ">save" mean the same thing; further spaces are
  // the user's and are left in the query.
  return { mode: 'commands', query: raw.slice(1).replace(/^ /, '') }
}

export interface AssetRow {
  /** Stable across re-renders; used for React keys and `aria-activedescendant`. */
  id: string
  kind: 'skill' | 'reference' | 'draft'
  name: string
  title: string
  description: string
  tier: string | null
  /** Present only on draft rows: everything needed to reopen it. */
  draft?: {
    draftId?: string
    kind: AuthoringKind
    mode: 'edit' | 'create'
    updatedAt: string
  }
}

export function corpusRows(items: readonly CorpusItem[]): AssetRow[] {
  return items.map((i) => ({
    id: `${i.kind}:${i.name}`,
    kind: i.kind,
    name: i.name,
    title: i.title,
    description: i.description,
    tier: i.tier
  }))
}

/**
 * Spec §4.5 and §6.2: drafts the user would otherwise never see again, since §10 cut draft
 * visibility from the Library outright.
 *
 * Two populations, and only two:
 *   - **create mode** — never saved, so there is no asset row that would open it. Always listed.
 *   - **edit mode with its asset gone** — the orphan §4.5 keeps. An edit draft whose file still
 *     exists is deliberately NOT listed: opening the asset restores that draft anyway (see
 *     `AssetTab`'s resolve), and listing it would double every file the user has touched.
 */
export function draftRows(
  drafts: readonly DraftRecord[],
  corpus: readonly CorpusItem[]
): AssetRow[] {
  const exists = new Set(corpus.map((c) => `${c.kind}:${c.name}`))
  return drafts
    .filter((d) => d.mode === 'create' || !exists.has(`${d.kind}:${d.name}`))
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((d) => ({
      // Create drafts are id-keyed (two may legitimately share a typed name — see `keyOf` in
      // main/services/drafts.ts), edit drafts are kind+name-keyed. The row id follows the same
      // split, or two same-named create drafts would collide into one React key.
      id: d.draftId ? `draft:${d.draftId}` : `draft:${d.kind}:${d.name}`,
      kind: 'draft' as const,
      name: d.name,
      title: '',
      description: '',
      tier: null,
      draft: {
        ...(d.draftId ? { draftId: d.draftId } : {}),
        kind: d.kind,
        mode: d.mode,
        updatedAt: d.updatedAt
      }
    }))
}

/** A title or description hit counts for less than a name hit, so typing a filename does not put
 *  some other file's prose above it. This used to be expressed as a multiplier on the score, but
 *  `fuzzyMatch` can return a negative score (its lead-in penalty can outweigh its bonuses), and
 *  multiplying a negative score by a fraction moves it *toward* zero — i.e. makes a weak title
 *  hit look stronger, the opposite of a discount. So the preference is instead an explicit
 *  ranking key (`nameMatched`) ahead of the score, and the score itself is left raw. */
export function rankAssets(rows: readonly AssetRow[], query: string): AssetRow[] {
  if (query === '') return rows.slice().sort(draftsLast)
  const scored: { row: AssetRow; score: number; nameMatched: boolean }[] = []
  for (const row of rows) {
    const name = fuzzyMatch(query, row.name)
    const title = row.title ? fuzzyMatch(query, row.title) : null
    const desc = row.description ? fuzzyMatch(query, row.description) : null
    const score = Math.max(
      name ? name.score : -Infinity,
      title ? title.score : -Infinity,
      desc ? desc.score : -Infinity
    )
    if (score !== -Infinity) scored.push({ row, score, nameMatched: name !== null })
  }
  return scored
    .sort(
      (a, b) =>
        draftsLast(a.row, b.row) ||
        Number(b.nameMatched) - Number(a.nameMatched) ||
        b.score - a.score ||
        a.row.name.localeCompare(b.row.name)
    )
    .map((s) => s.row)
}

/** Drafts are their own section (spec §6.2), so they sort after everything else regardless of
 *  score — the component draws the section header at the first draft row. */
function draftsLast(a: AssetRow, b: AssetRow): number {
  return (a.kind === 'draft' ? 1 : 0) - (b.kind === 'draft' ? 1 : 0)
}

export function rankCommands(cmds: readonly Command[], query: string): Command[] {
  if (query === '') return cmds.slice()
  return cmds
    .map((c) => ({ c, m: fuzzyMatch(query, c.title) }))
    .filter((x): x is { c: Command; m: { score: number; positions: number[] } } => x.m !== null)
    .sort((a, b) => b.m.score - a.m.score)
    .map((x) => x.c)
}
