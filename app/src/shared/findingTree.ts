import { isFindingRole, type FindingRole } from './observability'
import { reviewTag } from './findingTag'

/** What the tree needs of a finding: a `FindingRow`, or a prompt projection row (which may lack
 *  an id on a pre-v3 snapshot and the chain fields on a pre-increment-2 one). */
export interface ChainRow {
  id?: number
  role: string | null
  reviewState: string
  causedBy?: number | null
  supersededBy?: number | null
}

export interface TreeNode<T extends ChainRow = ChainRow> {
  row: T
  depth: number
}

/**
 * A case's investigation findings as the user and the agent both read them (spec 2026-10-26
 * §5.4): `rootCause` holds every tree whose root has role root-cause, `unexplained` every other
 * active tree (its root has no recorded cause — the "chain stops here" the persona asks the
 * agent to admit), `ruledOut` the inactive rows flat, newest first. `pending` counts active
 * findings still unreviewed — the rail header's "N to review".
 */
export interface FindingTree<T extends ChainRow = ChainRow> {
  rootCause: TreeNode<T>[]
  unexplained: TreeNode<T>[]
  ruledOut: T[]
  pending: number
}

/** Rejected (by anyone), ruled out, a duplicate, or replaced by a newer finding. An edge that
 *  points at an inactive finding is treated as no edge: the children stay visible, unattached,
 *  which is exactly the gap a withdrawn cause leaves (spec §5.6). `!= null`: a projection row
 *  may carry no `supersededBy` at all. */
export function isInactiveFinding(f: {
  reviewState: string
  role: string | null
  supersededBy?: number | null
}): boolean {
  return (
    f.reviewState === 'rejected' ||
    f.role === 'ruled-out' ||
    f.role === 'duplicate' ||
    f.supersededBy != null
  )
}

const ROLE_RANK: Record<FindingRole, number> = {
  'root-cause': 0,
  contributing: 1,
  symptom: 2,
  'ruled-out': 3,
  duplicate: 4
}
const rank = (f: ChainRow): number => (isFindingRole(f.role) ? ROLE_RANK[f.role] : 3)
const idOf = (f: ChainRow, i: number): number => f.id ?? -(i + 1)

/** The only ordering of a case's findings. Pure: the rail, `list_findings` and every prompt
 *  site call it (through `renderFindingTree`). Rows without an id (pre-v3 snapshots) get a
 *  negative placeholder for the walk only; it never renders. */
export function buildFindingTree<T extends ChainRow>(rows: readonly T[]): FindingTree<T> {
  const keyed = rows.map((row, i) => ({ row, id: idOf(row, i) }))
  const byRankThenId = (a: { row: T; id: number }, b: { row: T; id: number }): number =>
    rank(a.row) - rank(b.row) || a.id - b.id
  const active = keyed.filter((k) => !isInactiveFinding(k.row))
  const ruledOut = keyed
    .filter((k) => isInactiveFinding(k.row))
    .sort((a, b) => b.id - a.id)
    .map((k) => k.row)
  const activeIds = new Set(active.map((k) => k.id))
  const children = new Map<number, { row: T; id: number }[]>()
  const roots: { row: T; id: number }[] = []
  for (const k of active) {
    const cause = k.row.causedBy ?? null
    if (cause !== null && activeIds.has(cause) && cause !== k.id) {
      const list = children.get(cause) ?? []
      list.push(k)
      children.set(cause, list)
    } else {
      roots.push(k)
    }
  }
  // A cycle (never written by updateFinding, but data is data) has no root: every member has an
  // active parent. Seed one root per unvisited member, lowest id first, so nothing is lost.
  const seen = new Set<number>()
  const out = { rootCause: [] as TreeNode<T>[], unexplained: [] as TreeNode<T>[] }
  const walk = (k: { row: T; id: number }, depth: number, into: TreeNode<T>[]): void => {
    if (seen.has(k.id)) return
    seen.add(k.id)
    into.push({ row: k.row, depth })
    for (const c of (children.get(k.id) ?? []).sort(byRankThenId)) walk(c, depth + 1, into)
  }
  const place = (k: { row: T; id: number }): void =>
    walk(k, 0, k.row.role === 'root-cause' ? out.rootCause : out.unexplained)
  for (const r of roots.sort(byRankThenId)) place(r)
  for (const k of [...active].sort((a, b) => a.id - b.id)) if (!seen.has(k.id)) place(k)
  return {
    ...out,
    ruledOut,
    pending: active.filter((k) => k.row.reviewState === 'pending').length
  }
}

/** A row `renderFindingTree` can print: the tag fields `reviewTag` reads plus summary and body. */
export interface TreeTextRow extends ChainRow {
  summary: string
  body?: string
  status?: string | null
  reviewActor?: string | null
  reviewReason?: string | null
  rejectTag?: string | null
  rejectNote?: string | null
}

export interface TreeHeadings {
  rootCause: string
  unexplained: string
  ruledOut: string
}

/** One line per finding: `#id · <tag> · <role | no role> · summary`, two spaces per depth with
 *  `↳ ` from depth 1. A row with no id (pre-v3 snapshot) drops the `#id · ` part. */
function line(f: TreeTextRow, depth: number): string {
  const indent = `${'  '.repeat(depth)}${depth > 0 ? '↳ ' : ''}`
  const id = f.id !== undefined ? `#${f.id} · ` : ''
  return `${indent}${id}${reviewTag(f)} · ${f.role ?? 'no role'} · ${f.summary}`
}

/**
 * The one text form of the tree (spec 2026-10-26 §9.1): `list_findings` prints it without
 * bodies; the distill v2 prompt, the v3 dossier prompt and the RCA prompt print it with. With
 * `bodies`, a finding's body follows its line unindented (markdown must not be indented into a
 * code block), then a blank line; a superseded row (§9.3) never gets a body — it is folded into
 * its successor. Empty input renders as the empty string: the caller decides what "(none)" is.
 */
export function renderFindingTree(
  rows: readonly TreeTextRow[],
  opts: { headings: TreeHeadings; bodies?: boolean }
): string {
  if (rows.length === 0) return ''
  const tree = buildFindingTree(rows)
  const entry = (f: TreeTextRow, depth: number): string => {
    const l = line(f, depth)
    if (!opts.bodies) return l
    const body = f.supersededBy != null ? '' : (f.body ?? '').trim()
    return body ? `${l}\n${body}\n` : `${l}\n`
  }
  // Entries with bodies already end in `\n`, so one `\n` joiner is the blank line between them.
  const section = (heading: string, nodes: TreeNode<TreeTextRow>[]): string =>
    [heading, ...nodes.map((n) => entry(n.row, n.depth))].join('\n')
  const sections: string[] = []
  if (tree.rootCause.length > 0) sections.push(section(opts.headings.rootCause, tree.rootCause))
  if (tree.unexplained.length > 0)
    sections.push(section(opts.headings.unexplained, tree.unexplained))
  if (tree.ruledOut.length > 0)
    sections.push(
      section(
        opts.headings.ruledOut,
        tree.ruledOut.map((row) => ({ row, depth: 0 }))
      )
    )
  return sections.join('\n\n')
}
