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

/** Called when a single sibling is deleted (triage 3 — `deleteSkillFile`'s counterpart to
 *  `dropSkillAssetReviews` above, scoped to one file rather than the whole skill). The read side
 *  is already safe without this: `assetReviewState` keys on `(skill, rel_path)` AND compares the
 *  sha256, so a stale row can only ever come back `reviewed` for content byte-identical to what a
 *  human approved at that exact path — a leftover row cannot forge approval for different bytes.
 *  Still, an orphan row for a file that no longer exists is dead weight worth cleaning up.
 *  Also subject to the KNOWN IMPRECISION above: since the key carries no tier, deleting
 *  `skill/rel_path` from the user-tier copy drops the same row a hivemind-tier skill of the same
 *  name was reading — the safe direction (that copy falls back to `unreviewed`, costing one extra
 *  approval, never a forged one). */
export function dropSkillAssetReview(db: DatabaseSync, skill: string, relPath: string): void {
  db.prepare(`DELETE FROM skill_asset_reviews WHERE skill = ? AND rel_path = ?`).run(skill, relPath)
}

/** Called when a single sibling is renamed. `(skill, rel_path)` is the row's unique key, so a
 *  blind UPDATE risks a constraint violation if an orphan row already sits at the destination
 *  path (e.g. left by a delete that predates the `dropSkillAssetReview` fix) — clear that first,
 *  same as `renameSkillFile` refuses a rename onto a path that already has a FILE.
 *  Also subject to the KNOWN IMPRECISION above: the DELETE-then-UPDATE both filter on `skill`
 *  alone with no tier column, so renaming the user-tier copy's file can drop or repoint the row a
 *  same-named hivemind-tier skill was reading — again the safe direction, since a surviving row
 *  can only read back `reviewed` for byte-identical content at that exact path. */
export function renameSkillAssetReview(
  db: DatabaseSync,
  skill: string,
  from: string,
  to: string
): void {
  db.prepare(`DELETE FROM skill_asset_reviews WHERE skill = ? AND rel_path = ?`).run(skill, to)
  db.prepare(`UPDATE skill_asset_reviews SET rel_path = ? WHERE skill = ? AND rel_path = ?`).run(
    to,
    skill,
    from
  )
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
