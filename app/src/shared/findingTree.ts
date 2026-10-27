import type { FindingRole, FindingRow } from './observability'

export interface TreeNode {
  row: FindingRow
  depth: number
}

/**
 * A case's investigation findings as the user and the agent both read them (spec 2026-10-26
 * §5.4): `rootCause` holds every tree whose root has role root-cause, `unexplained` every other
 * active tree (its root has no recorded cause — the "chain stops here" the persona asks the
 * agent to admit), `ruledOut` the inactive rows flat, newest first. `pending` counts active
 * findings still unreviewed — the rail header's "N to review".
 */
export interface FindingTree {
  rootCause: TreeNode[]
  unexplained: TreeNode[]
  ruledOut: FindingRow[]
  pending: number
}

/** Rejected (by anyone), ruled out, a duplicate, or replaced by a newer finding. An edge that
 *  points at an inactive finding is treated as no edge: the children stay visible, unattached,
 *  which is exactly the gap a withdrawn cause leaves (spec §5.6). */
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
const rank = (f: FindingRow): number => (f.role ? ROLE_RANK[f.role] : 3)
const byRankThenId = (a: FindingRow, b: FindingRow): number => rank(a) - rank(b) || a.id - b.id

/** The only ordering of a case's findings. Pure: the rail and `list_findings` both call it. */
export function buildFindingTree(rows: readonly FindingRow[]): FindingTree {
  const active = rows.filter((f) => !isInactiveFinding(f))
  const ruledOut = rows.filter(isInactiveFinding).sort((a, b) => b.id - a.id)
  const activeIds = new Set(active.map((f) => f.id))
  const children = new Map<number, FindingRow[]>()
  const roots: FindingRow[] = []
  for (const f of active) {
    if (f.causedBy !== null && activeIds.has(f.causedBy) && f.causedBy !== f.id) {
      const list = children.get(f.causedBy) ?? []
      list.push(f)
      children.set(f.causedBy, list)
    } else {
      roots.push(f)
    }
  }
  // A cycle (never written by updateFinding, but data is data) has no root: every member has an
  // active parent. Seed one root per unvisited member, lowest id first, so nothing is lost.
  const seen = new Set<number>()
  const out = { rootCause: [] as TreeNode[], unexplained: [] as TreeNode[] }
  const walk = (f: FindingRow, depth: number, into: TreeNode[]): void => {
    if (seen.has(f.id)) return
    seen.add(f.id)
    into.push({ row: f, depth })
    for (const c of (children.get(f.id) ?? []).sort(byRankThenId)) walk(c, depth + 1, into)
  }
  const place = (f: FindingRow): void =>
    walk(f, 0, f.role === 'root-cause' ? out.rootCause : out.unexplained)
  for (const r of roots.sort(byRankThenId)) place(r)
  for (const f of [...active].sort((a, b) => a.id - b.id)) if (!seen.has(f.id)) place(f)
  return {
    ...out,
    ruledOut,
    pending: active.filter((f) => f.reviewState === 'pending').length
  }
}
