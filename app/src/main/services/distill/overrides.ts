import type { DatabaseSync } from 'node:sqlite'
import {
  matchAssetMention,
  type AssetKind,
  type AttributionRow,
  type OverrideSource
} from '../../../shared/attribution'
import type { RejectReason } from '../../../shared/proposals'
import { applyAttributionOverride, assetNamesForCase } from './attributions'
import { refFileName } from '../proposals'

/** A finding-scoped free text (a retraction reason, a human reject note) that names an asset of
 *  the finding's case flips that asset to misled, stamped with `source`. */
function overrideFromFindingText(
  db: DatabaseSync,
  findingId: number,
  text: string,
  source: Extract<OverrideSource, 'finding-retraction' | 'finding-reject'>
): AttributionRow | null {
  const f = db
    .prepare(
      `SELECT c.slug AS slug FROM findings f JOIN cases c ON c.id = f.case_id WHERE f.id = ?`
    )
    .get(findingId) as { slug: string } | undefined
  if (!f) return null
  const hit = matchAssetMention(text, assetNamesForCase(db, f.slug))
  if (!hit) return null
  return applyAttributionOverride(db, {
    caseSlug: f.slug,
    kind: hit.kind,
    name: hit.name,
    verdict: 'misled',
    source
  })
}

/** Spec §4.7: a retraction whose reason names an asset of that case flips it to misled. */
export function overrideFromRetraction(
  db: DatabaseSync,
  findingId: number,
  reason: string
): AttributionRow | null {
  return overrideFromFindingText(db, findingId, reason, 'finding-retraction')
}

/** Spec 2026-10-25 §4.6: a human `wrong` reject whose note names an asset of the case flips it
 *  to misled. The caller decides the tag gate (`wrong` only); this function only matches. */
export function overrideFromFindingReject(
  db: DatabaseSync,
  findingId: number,
  note: string
): AttributionRow | null {
  return overrideFromFindingText(db, findingId, note, 'finding-reject')
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
