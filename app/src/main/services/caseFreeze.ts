import type { DatabaseSync } from 'node:sqlite'

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
 * call the guard are in `ingest.ts`, `scan.ts`, `extraction.ts` and
 * `agent/sessionStore.ts` + `agent/mirror.ts`, several of which `caseArchive` transitively
 * imports. It therefore imports NOTHING from the services layer — the archived check is a
 * one-column raw query rather than `caseService.getCase`, because `sessionStore` is imported
 * BY `caseService`, and routing through it would close a real import cycle.
 *
 * The registry is a Map slug → token, not a Set, and the freeze is NOT reentrant. Two
 * overlapping archives of the same slug used to both "succeed" at freezing and then the
 * first to finish released the OTHER one's freeze, reopening the write window it was still
 * inside. `freezeCase` now refuses a slug that is already frozen, and only the returned
 * handle can release it.
 */
const frozen = new Map<string, symbol>()

/** A freeze that only its owner can release. Returned by `freezeCase`; call `release()` in a
 *  `finally` so no throw can leave a case permanently unwritable. */
export interface FreezeHandle {
  readonly slug: string
  release(): void
}

/**
 * Mark a case unwritable and take ownership of that freeze.
 *
 * Throws if the case is ALREADY frozen. That refusal is the whole point: an idempotent
 * freeze plus a slug-keyed release means whichever holder finishes first unfreezes the case
 * for everybody, including a concurrent archive still inside its verify window. The message
 * is user-facing — a double-clicked archive button, two windows, or a retry over a slow
 * first attempt all land here.
 *
 * Callers MUST pair this with `handle.release()` in a `finally`.
 */
export function freezeCase(slug: string): FreezeHandle {
  if (frozen.has(slug)) {
    throw new Error(
      `Case ${slug} is already being archived. Wait for that operation to finish before starting another.`
    )
  }
  const token = Symbol(slug)
  frozen.set(slug, token)
  return {
    slug,
    release(): void {
      // Identity-checked: a stale handle from an earlier, already-released freeze must never
      // release the freeze a LATER archive of the same slug now holds.
      if (frozen.get(slug) === token) frozen.delete(slug)
    }
  }
}

/** Test/diagnostic reader. Production code should call `assertCaseWritable` instead. */
export function isCaseFrozen(slug: string): boolean {
  return frozen.has(slug)
}

/**
 * True once a case's bundle is sealed. The durable half of the guard below, exported so read
 * paths that must DEGRADE rather than throw on an archived case (`listSessions`, which would
 * otherwise auto-create a session into a case whose sessions were just deleted) can ask the
 * same question without catching an exception. Unknown slug → false, same as the guard.
 */
export function isCaseArchived(db: DatabaseSync, slug: string): boolean {
  const rec = db.prepare(`SELECT archived_at FROM cases WHERE slug = ?`).get(slug) as
    { archived_at: string | null } | undefined
  return Boolean(rec?.archived_at)
}

/**
 * Throw unless new files may be written into this case's tree.
 *
 * Refuses BOTH states that make a write unsafe:
 *  - frozen: an archive is in flight, and anything written now is outside the bundle.
 *  - archived: the bundle is already sealed, so a new file would not be in it — and it would
 *    also collide with the directory rename a later restore performs.
 *
 * NOTE: an UNKNOWN slug passes silently. This guard answers "may this case be written?", not
 * "does this case exist?" — callers that need the case to exist check that themselves (every
 * IPC handler already does, via `getCase`). So a passing call does not prove there is a row.
 */
export function assertCaseWritable(db: DatabaseSync, slug: string): void {
  if (frozen.has(slug)) {
    throw new Error(
      `Case ${slug} is being archived right now and cannot accept new files. Try again once archiving finishes.`
    )
  }
  if (isCaseArchived(db, slug)) {
    throw new Error(`Case ${slug} is archived and cannot accept new files. Restore it first.`)
  }
}
