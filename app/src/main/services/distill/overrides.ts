import type { DatabaseSync } from 'node:sqlite'
import { matchAssetMention, type AssetKind, type AttributionRow } from '../../../shared/attribution'
import type { RejectReason } from '../../../shared/proposals'
import { applyAttributionOverride, assetNamesForCase } from './attributions'
import { refFileName } from '../proposals'

/** Spec §4.7: a retraction whose reason names an asset of that case flips it to misled. */
export function overrideFromRetraction(
  db: DatabaseSync,
  findingId: number,
  reason: string
): AttributionRow | null {
  const f = db
    .prepare(
      `SELECT c.slug AS slug FROM findings f JOIN cases c ON c.id = f.case_id WHERE f.id = ?`
    )
    .get(findingId) as { slug: string } | undefined
  if (!f) return null
  const hit = matchAssetMention(reason, assetNamesForCase(db, f.slug))
  if (!hit) return null
  return applyAttributionOverride(db, {
    caseSlug: f.slug,
    kind: hit.kind,
    name: hit.name,
    verdict: 'misled',
    source: 'finding-retraction'
  })
}

const EDIT_KIND: Record<string, AssetKind> = {
  'skill-edit': 'skill',
  'reference-edit': 'reference'
}

/** Spec §4.7: rejecting an EDIT proposal as wrong/overfit says the asset misled in this case.
 *  overgeneric/duplicate/other say nothing about the asset's help, so they never override. */
export function overrideFromProposalReject(
  db: DatabaseSync,
  p: { caseSlug: string; type: string; target: string },
  reason?: RejectReason
): AttributionRow | null {
  if (!reason || (reason.tag !== 'wrong' && reason.tag !== 'overfit')) return null
  const kind = EDIT_KIND[p.type]
  if (!kind) return null
  // The inventory names a reference by relPath WITH extension (`limits.md`); a reference-edit
  // target is the flat name, usually without it (`limits`). A target is always top-level, so a
  // nested `nav/limits.md` the case read is never this file.
  const name = kind === 'reference' ? refFileName(p.target) : p.target
  const inCase = assetNamesForCase(db, p.caseSlug).some((a) => a.kind === kind && a.name === name)
  if (!inCase) return null
  return applyAttributionOverride(db, {
    caseSlug: p.caseSlug,
    kind,
    name,
    verdict: 'misled',
    source: 'proposal-reject'
  })
}
