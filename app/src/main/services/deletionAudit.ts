import fs from 'node:fs'
import path from 'node:path'
import { deletionAuditPath } from './paths'

export type DeletionOp = 'case.delete' | 'evidence.delete' | 'session.delete' | 'findings.clear'

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

export function readDeletionAudit(argusHome: string): DeletionAuditEntry[] {
  const p = deletionAuditPath(argusHome)
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as DeletionAuditEntry)
}
