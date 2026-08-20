import crypto from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AssetReviewState } from '../../shared/skillAssets'

/**
 * The reviewed-bytes record behind the executable-asset gate (spec §7.1).
 *
 * The gate's value is not "a script ran" — it is the difference between the bytes a human
 * approved and the bytes about to execute. Rows are written only where a human on THIS machine
 * reviewed the content: accepting a proposal, or saving the file in the editor. An imported or
 * HiveMind-pulled skill deliberately gets no row; a teammate's approval is not this user's.
 *
 * KNOWN IMPRECISION: rows are keyed `(skill, rel_path)` with no tier column, while skills
 * resolve across three tiers (user / hivemind / bundled) that can each hold a skill of the same
 * name. A user-tier and a hivemind-tier `collect-logs` that both ship `scripts/collect.sh` share
 * one row, so a review recorded against one can be read back for the other. The sha256 compare
 * still bounds the damage — identical bytes are what "reviewed" means, and any byte difference
 * comes back `changed` — but the row does not record WHICH copy was read. Widening the key needs
 * a schema migration; recorded here rather than fixed.
 */

export type { AssetReviewState }

export function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

export function recordAssetReviews(
  db: DatabaseSync,
  skill: string,
  assets: { relPath: string; content: string }[],
  opts: { origin: 'proposal' | 'editor'; reviewedBy: string | null; now?: Date }
): void {
  const at = (opts.now ?? new Date()).toISOString()
  const stmt = db.prepare(
    `INSERT INTO skill_asset_reviews (skill, rel_path, sha256, reviewed_at, reviewed_by, origin)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(skill, rel_path) DO UPDATE SET
       sha256 = excluded.sha256,
       reviewed_at = excluded.reviewed_at,
       reviewed_by = excluded.reviewed_by,
       origin = excluded.origin`
  )
  for (const a of assets) {
    stmt.run(skill, a.relPath, sha256Hex(a.content), at, opts.reviewedBy, opts.origin)
  }
}

export function assetReviewState(
  db: DatabaseSync,
  skill: string,
  relPath: string,
  content: string
): AssetReviewState {
  const row = db
    .prepare(`SELECT sha256 FROM skill_asset_reviews WHERE skill = ? AND rel_path = ?`)
    .get(skill, relPath) as { sha256: string } | undefined
  if (!row) return 'unreviewed'
  return row.sha256 === sha256Hex(content) ? 'reviewed' : 'changed'
}

/** Called when a skill's user-tier copy is deleted ("adopt upstream"): the rows described bytes
 *  that are gone. Identical content returning later costs one re-approval — the safe direction. */
export function dropSkillAssetReviews(db: DatabaseSync, skill: string): void {
  db.prepare(`DELETE FROM skill_asset_reviews WHERE skill = ?`).run(skill)
}

/** Fork copies the reviewed state: the bytes were genuinely reviewed, only the name changed. */
export function copySkillAssetReviews(db: DatabaseSync, from: string, to: string): void {
  db.prepare(
    `INSERT INTO skill_asset_reviews (skill, rel_path, sha256, reviewed_at, reviewed_by, origin)
     SELECT ?, rel_path, sha256, reviewed_at, reviewed_by, origin
       FROM skill_asset_reviews WHERE skill = ?
     ON CONFLICT(skill, rel_path) DO UPDATE SET
       sha256 = excluded.sha256,
       reviewed_at = excluded.reviewed_at,
       reviewed_by = excluded.reviewed_by,
       origin = excluded.origin`
  ).run(to, from)
}
