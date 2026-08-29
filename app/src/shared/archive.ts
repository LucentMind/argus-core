/**
 * The archive/restore result shapes, in `shared/` because they cross the IPC boundary.
 *
 * They were declared in `main/services/caseArchive.ts`, which is where the functions that
 * produce them live. The preload bridge and the renderer need to name them too, and every other
 * type on that surface is imported from `shared/` — a preload that reached into `main/` for a
 * type would be the only one, and hand-retyping the shape in the bridge is exactly the
 * one-fact-in-two-places drift this codebase keeps paying for. `caseArchive.ts` re-exports both,
 * so nothing that already imported them from there had to change.
 */

export interface ArchiveResult {
  slug: string
  bundlePath: string
  /** Bytes removed from cases/<slug> — what the operator actually got back. */
  bytesFreed: number
  evidenceRemoved: number
  sessionsRemoved: number
}

export interface RestoreResult {
  slug: string
  evidenceRestored: number
  sessionsRestored: number
  /** How many evidence rows were handed to the ingest queue for re-indexing. */
  queuedForIndex: number
  /**
   * Whether the archive bundle was removed from `<argusHome>/archive` once the restore
   * committed. A successful restore deletes it — the case's bulk is back under `cases/`, nothing
   * in the database points at the zip any more, and a later archive of the same slug would
   * silently overwrite it. False means the delete failed (a Windows open handle, permissions):
   * the restore still succeeded, but those bytes were NOT reclaimed and the operator has to be
   * told rather than left with a `bytesFreed` figure that never came back.
   */
  bundleRemoved: boolean
}
