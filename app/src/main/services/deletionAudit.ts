import fs from 'node:fs'
import path from 'node:path'
import { deletionAuditPath } from './paths'

/**
 * `case.archive` is a destruction record like the rest, not a lifecycle event: archiving deletes
 * every evidence, session, turn and tool-call row for a case and the on-disk trees behind them.
 * It belongs in this journal for exactly the reason `case.delete` does — the journal has to
 * outlive the data — and its detail names the bundle those bytes moved into.
 */
/**
 * `case.delete.residue` CORRECTS the `case.delete` line immediately before it. The delete's own
 * entry is written straight after the COMMIT, before the on-disk removals, so that a crash
 * mid-removal still leaves a record of the destruction the database has already made permanent —
 * the journal has to outlive the data. That ordering means the entry cannot yet know whether the
 * bytes actually went, and on Windows a transient EBUSY says they did not. This second entry
 * names what is still on disk, so a reader of the journal is never left with an unqualified
 * "case deleted" over bytes that survived it.
 */
export type DeletionOp =
  | 'case.delete'
  | 'case.delete.residue'
  | 'case.archive'
  | 'evidence.delete'
  | 'session.delete'
  | 'findings.clear'
  | 'finding.delete'

export interface DeletionAuditEntry {
  ts: string
  op: DeletionOp
  caseSlug: string
  detail: Record<string, unknown>
}

/**
 * Append-only journal of destructive operations (chain-of-custody record that
 * outlives the deleted data). Modeled on the memory audit (memory.ts). Written
 * after the DB commit and regardless of filesystem outcome; no reader UI in v1.
 */
export function appendDeletionAudit(
  argusHome: string,
  op: DeletionOp,
  caseSlug: string,
  detail: Record<string, unknown>
): DeletionAuditEntry {
  const entry: DeletionAuditEntry = { ts: new Date().toISOString(), op, caseSlug, detail }
  const p = deletionAuditPath(argusHome)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.appendFileSync(p, JSON.stringify(entry) + '\n')
  return entry
}

/**
 * Size of a case's archive bundle on disk, or null when there is none.
 *
 * Lives here rather than in `caseArchive.ts` because both of its callers are audit lines —
 * `archiveCase`'s `case.archive` entry and `deleteCase`'s `case.delete` entry — and
 * `caseArchive` imports `caseService`, so a helper owned by the former and used by the latter
 * would close an import cycle. Null rather than 0 for an absent file: an audit reader must be
 * able to tell "there was no bundle" from "there was an empty one", and both callers derive
 * their retained/deleted flags from exactly that distinction. Best-effort — a stat failure must
 * never fail the operation being audited.
 */
export function bundleBytes(bundlePath: string): number | null {
  try {
    return fs.statSync(bundlePath).size
  } catch {
    return null
  }
}

export function readDeletionAudit(argusHome: string): DeletionAuditEntry[] {
  const p = deletionAuditPath(argusHome)
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as DeletionAuditEntry)
}
