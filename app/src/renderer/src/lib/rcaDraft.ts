import { FINDING_ROLES } from '../../../shared/observability'
import type { FindingRole } from '../../../shared/observability'
import type { Citation, PostResults, RcaDraft, RoleAssignment } from '../../../shared/rca'

/**
 * Pure helpers backing `RcaPanel` (task-11 brief): the claim card model, the role-reassignment
 * and duplicate-veto edits, and the assignment builder the "Confirm & freeze" action sends to
 * `rca.confirm`. Kept out of `RcaPanel.tsx` itself so the component file exports only the
 * component (`react-refresh/only-export-components` — see FindingCard.tsx for the same split)
 * while these stay directly unit-testable from `RcaPanel.test.tsx`.
 */

/**
 * Pure assignment builder (task-11 brief, verbatim): every claim with a non-null `findingId`
 * contributes its section's role; among rootCause/contributing/symptoms/ruledOut, the FIRST
 * role a finding id is seen under wins (a finding cannot hold two roles). Duplicates are
 * walked last and deliberately OVERRIDE whatever role (if any) that finding id already
 * claimed — an un-vetoed duplicate always ends up assigned 'duplicate', even if the model
 * also double-listed it as e.g. contributing. A vetoed duplicate is excluded entirely rather
 * than downgraded back to its earlier role.
 */
export function buildAssignments(draft: RcaDraft, vetoed: Set<number>): RoleAssignment[] {
  const out = new Map<number, FindingRole>()
  const put = (id: number | null, role: FindingRole): void => {
    if (id !== null && !out.has(id)) out.set(id, role)
  }
  put(draft.rootCause.findingId, 'root-cause')
  draft.contributing.forEach((c) => put(c.findingId, 'contributing'))
  draft.symptoms.forEach((s) => put(s.findingId, 'symptom'))
  draft.ruledOut.forEach((r) => put(r.findingId, 'ruled-out'))
  draft.duplicates.forEach((d) => {
    if (!vetoed.has(d.findingId)) out.set(d.findingId, 'duplicate')
  })
  return [...out.entries()].map(([findingId, role]) => ({ findingId, role }))
}

/** The role a claim card can be moved to: the four `FindingRole`s the brief lists for claim
 *  cards, minus `'duplicate'` (duplicates are a separate, veto-only list) — plus
 *  `'unclassified'`, which has no `FindingRole` counterpart and instead means "drop this claim
 *  out of the draft entirely" (see {@link applyClaims}). */
export type ClaimRole = Exclude<FindingRole, 'duplicate'> | 'unclassified'

export const CLAIM_ROLES: Exclude<FindingRole, 'duplicate'>[] = FINDING_ROLES.filter(
  (r): r is Exclude<FindingRole, 'duplicate'> => r !== 'duplicate'
)

export const ROLE_LABEL: Record<Exclude<FindingRole, 'duplicate'>, string> = {
  'root-cause': 'Root cause',
  contributing: 'Contributing',
  symptom: 'Symptom',
  'ruled-out': 'Ruled out'
}

export const TARGET_LABEL: Record<keyof PostResults, string> = {
  comment: 'Jira comment',
  attachment: 'Jira attachment',
  confluencePage: 'Confluence page'
}

/** One claim card, unified across the draft's four differently-shaped sections (rootCause is a
 *  single object; contributing/symptoms/ruledOut are arrays with different fields) so a role
 *  change can move a claim between them without a shape conversion at every call site. `key` is
 *  a stable per-render identity (not `findingId` — a claim can carry `findingId: null`, and two
 *  claims must never collide on the same React key). */
export interface Claim {
  key: string
  findingId: number | null
  statement: string
  role: Exclude<FindingRole, 'duplicate'>
  evidence: Citation[]
  why: string
}

export function draftToClaims(draft: RcaDraft): Claim[] {
  const claims: Claim[] = [
    {
      key: 'root',
      findingId: draft.rootCause.findingId,
      statement: draft.rootCause.statement,
      role: 'root-cause',
      evidence: draft.rootCause.evidence,
      why: ''
    }
  ]
  draft.contributing.forEach((c, i) =>
    claims.push({
      key: `contributing-${i}`,
      findingId: c.findingId,
      statement: c.statement,
      role: 'contributing',
      evidence: c.evidence,
      why: ''
    })
  )
  draft.symptoms.forEach((s, i) =>
    claims.push({
      key: `symptom-${i}`,
      findingId: s.findingId,
      statement: s.statement,
      role: 'symptom',
      evidence: [],
      why: ''
    })
  )
  draft.ruledOut.forEach((r, i) =>
    claims.push({
      key: `ruled-out-${i}`,
      findingId: r.findingId,
      statement: r.statement,
      role: 'ruled-out',
      evidence: [],
      why: r.why
    })
  )
  return claims
}

/** Rebuilds the four claim sections of `base` from the edited `claims` list — everything else
 *  on `base` (impact, timeline, remediation, execSummary, techNarrative, duplicates) passes
 *  through untouched, since this panel has no editor for them. This is what `buildAssignments`
 *  and the confirm/preview IPC calls consume as "the edited draft": role edits in the cards are
 *  derivable from `claims` alone, so there is exactly one place a claim's current role lives. */
export function applyClaims(base: RcaDraft, claims: Claim[]): RcaDraft {
  const rootClaim = claims.find((c) => c.role === 'root-cause')
  return {
    ...base,
    rootCause: rootClaim
      ? {
          findingId: rootClaim.findingId,
          statement: rootClaim.statement,
          evidence: rootClaim.evidence
        }
      : { findingId: null, statement: '', evidence: [] },
    contributing: claims
      .filter((c) => c.role === 'contributing')
      .map((c) => ({ findingId: c.findingId, statement: c.statement, evidence: c.evidence })),
    symptoms: claims
      .filter((c) => c.role === 'symptom')
      .map((c) => ({ findingId: c.findingId, statement: c.statement })),
    ruledOut: claims
      .filter((c) => c.role === 'ruled-out')
      .map((c) => ({ findingId: c.findingId, statement: c.statement, why: c.why }))
  }
}

/** Moves one claim to `role`. `'unclassified'` drops it out of the claims list entirely (so it
 *  is absent from every section `applyClaims` rebuilds, and so from `buildAssignments`'s walk —
 *  there is deliberately no "unclassified" bucket in `RcaDraft` to put it back into). Promoting
 *  a second claim to `'root-cause'` demotes whichever claim held that single slot before it to
 *  `'contributing'` rather than silently discarding it — `RcaDraft.rootCause` has room for only
 *  one. */
export function reassign(claims: Claim[], key: string, role: ClaimRole): Claim[] {
  if (role === 'unclassified') return claims.filter((c) => c.key !== key)
  if (role === 'root-cause') {
    return claims.map((c) => {
      if (c.key === key) return { ...c, role: 'root-cause' as const }
      if (c.role === 'root-cause') return { ...c, role: 'contributing' as const }
      return c
    })
  }
  return claims.map((c) => (c.key === key ? { ...c, role } : c))
}

/** Detaches one claim from its finding: sets `findingId` to `null`, keeping the claim's
 *  statement/evidence/role exactly as they were. The claim stays visible and editable in its
 *  section, but `buildAssignments` skips it (its `put`/duplicate walks only act on non-null
 *  ids), so confirming writes no role for that finding. Recovery path for a claim whose
 *  finding id `applyReportRoles` rejects (finding deleted/moved to another case since the
 *  draft was generated) — see `RcaPanel`'s confirm-error handling. */
export function detachClaim(claims: Claim[], key: string): Claim[] {
  return claims.map((c) => (c.key === key ? { ...c, findingId: null } : c))
}

export function targetsMessage(
  techDestination: 'attachment' | 'confluence-page',
  spaceKey: string
): string {
  const tech =
    techDestination === 'confluence-page'
      ? `a Confluence page${spaceKey ? ` in space ${spaceKey}` : ''}`
      : 'an attachment on the Jira issue'
  return `Posts the exec summary as a Jira comment, and the full technical report as ${tech}.`
}
