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
const frozen = new Map<string, { token: symbol; operation: FreezeOperation }>()

/**
 * Which long operation holds (or would hold) the freeze. Recorded with the token because the
 * refusal messages below are USER-FACING and previously said "already being archived" for both
 * — a second Restore click reported a collision with an archive nobody started.
 */
export type FreezeOperation = 'archive' | 'restore'

const IN_PROGRESS: Record<FreezeOperation, string> = {
  archive: 'archived',
  restore: 'restored'
}

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
 * first attempt all land here — so it names the operation ALREADY RUNNING (the holder's), not
 * the one being attempted: "wait for that operation to finish" is only actionable if the user
 * can tell which operation that is.
 *
 * Callers MUST pair this with `handle.release()` in a `finally`.
 */
export function freezeCase(slug: string, operation: FreezeOperation): FreezeHandle {
  const held = frozen.get(slug)
  if (held) {
    throw new Error(
      `Case ${slug} is already being ${IN_PROGRESS[held.operation]}. Wait for that operation to finish before starting another.`
    )
  }
  const token = Symbol(slug)
  frozen.set(slug, { token, operation })
  return {
    slug,
    release(): void {
      // Identity-checked: a stale handle from an earlier, already-released freeze must never
      // release the freeze a LATER archive of the same slug now holds.
      if (frozen.get(slug)?.token === token) frozen.delete(slug)
    }
  }
}

/** Test/diagnostic reader. Production code should call `assertCaseWritable` instead. */
export function isCaseFrozen(slug: string): boolean {
  return frozen.has(slug)
}

/**
 * Which operation currently holds this case's freeze, or null if it is not frozen.
 *
 * `isCaseFrozen` above discards the operation, so every caller that builds a USER-FACING
 * refusal from it had to guess — and `assertCaseDeletable` guessed "archived", telling a user
 * mid-RESTORE to wait for an archive nobody started. That is the same wrong-operation defect
 * `freezeCase` and `assertCaseWritable` already fixed by reading `IN_PROGRESS`; this reader
 * exists so the third message can be built from that ONE map too, rather than a third copy of
 * the fact drifting on its own.
 */
export function frozenOperation(slug: string): FreezeOperation | null {
  return frozen.get(slug)?.operation ?? null
}

/**
 * The past participle a refusal message should use for an operation: 'archived' / 'restored'.
 * Exported so the messages built outside this module (`assertCaseDeletable`) read from the same
 * table as the two built inside it.
 */
export function inProgressWord(operation: FreezeOperation): string {
  return IN_PROGRESS[operation]
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
 *  - archived: the bundle is already sealed, so a new file would not be in it — and a restore
 *    replaces the case tree from that bundle, so anything written after archiving is silently
 *    discarded the moment the case comes back. (It is NOT that a write would collide with a
 *    rename: archiving deliberately leaves the RCA report files in `artifacts/`, so the
 *    directory survives. See the same argument at `rca/artifacts.ts`'s writeReportMarkdown.)
 *
 * NOTE: an UNKNOWN slug passes silently. This guard answers "may this case be written?", not
 * "does this case exist?" — callers that need the case to exist check that themselves (every
 * IPC handler already does, via `getCase`). So a passing call does not prove there is a row.
 */
export function assertCaseWritable(db: DatabaseSync, slug: string): void {
  const held = frozen.get(slug)
  if (held) {
    // Names the operation actually holding the freeze, for the same reason `freezeCase`'s
    // refusal does: "try again once archiving finishes" during a RESTORE tells the user to wait
    // for something that is not running.
    throw new Error(
      `Case ${slug} is being ${IN_PROGRESS[held.operation]} right now and cannot accept new files. Try again once that operation finishes.`
    )
  }
  if (isCaseArchived(db, slug)) {
    throw new Error(`Case ${slug} is archived and cannot accept new files. Restore it first.`)
  }
}
