import type { DatabaseSync } from 'node:sqlite'
import { getCase } from './caseService'

/**
 * In-process freeze registry for cases undergoing a long, snapshot-based operation.
 *
 * `archiveCase` snapshots the case tree into a bundle and then spends seconds to minutes
 * verifying that bundle before it deletes anything. A file written into `evidence/`,
 * `artifacts/` or `sessions/` inside that window would be deleted from disk AND from the
 * database while no copy exists in the verified bundle — silent, unrecoverable loss. The
 * freeze closes that window by making the case unwritable for the whole operation.
 *
 * Deliberately in-process and not persisted: the freeze must not survive a crash, because a
 * crashed archive leaves the case whole and it must stay writable. The DURABLE guard for a
 * successfully archived case is `cases.archived_at`, checked by the same function below.
 *
 * Lives in its own module rather than in `caseArchive.ts` because the write paths that must
 * call the guard are in `ingest.ts`, and `caseArchive → bundle → ingest` would make that a
 * cycle.
 */
const frozen = new Set<string>()

/** Mark a case unwritable. Callers MUST pair this with `unfreezeCase` in a `finally`. */
export function freezeCase(slug: string): void {
  frozen.add(slug)
}

/** Release a freeze. Safe to call for a slug that is not frozen. */
export function unfreezeCase(slug: string): void {
  frozen.delete(slug)
}

/** Test/diagnostic reader. Production code should call `assertCaseWritable` instead. */
export function isCaseFrozen(slug: string): boolean {
  return frozen.has(slug)
}

/**
 * Throw unless new files may be written into this case's tree.
 *
 * Refuses BOTH states that make a write unsafe:
 *  - frozen: an archive is in flight, and anything written now is outside the bundle.
 *  - archived: the bundle is already sealed, so a new file would not be in it — and it would
 *    also collide with the directory rename a later restore performs.
 */
export function assertCaseWritable(db: DatabaseSync, slug: string): void {
  if (frozen.has(slug)) {
    throw new Error(
      `Case ${slug} is being archived right now and cannot accept new files. Try again once archiving finishes.`
    )
  }
  const rec = getCase(db, slug)
  if (rec?.archivedAt) {
    throw new Error(`Case ${slug} is archived and cannot accept new files. Restore it first.`)
  }
}
