/**
 * Which mode a piece of case material belongs to, expressed as where it is stored.
 *
 * There is no scope column: `artifacts/…` is review material and everything else is
 * investigation material, so a file's directory IS its scope. That keeps the evidence
 * table unmigrated and makes the two lists disjoint by construction — the evidence
 * rescan never walks `artifacts/`, so review material cannot leak into an investigation
 * by omission.
 */
import type { ModeId } from './modes'

export const EVIDENCE_DIR = 'evidence'
export const ARTIFACTS_DIR = 'artifacts'
export type CaseSubdir = typeof EVIDENCE_DIR | typeof ARTIFACTS_DIR

export const ARTIFACTS_PREFIX = `${ARTIFACTS_DIR}/`

/** A listing scope: one mode's material, or everything. */
export type EvidenceScope = ModeId | 'all'

export function dirForMode(mode: ModeId): CaseSubdir {
  return mode === 'review' ? ARTIFACTS_DIR : EVIDENCE_DIR
}

export function scopeOfRelPath(relPath: string): ModeId {
  return relPath.startsWith(ARTIFACTS_PREFIX) ? 'review' : 'investigation'
}

/**
 * The sidecar that mirrors a stored file: `<top>/.meta/<rest>.json`. Replaces the
 * hardcoded `slice('evidence/'.length)` arithmetic that assumed one directory.
 */
export function sidecarRelPath(relPath: string): string {
  const cut = relPath.indexOf('/')
  if (cut <= 0) throw new Error(`Evidence path has no top-level directory: ${relPath}`)
  return `${relPath.slice(0, cut)}/.meta/${relPath.slice(cut + 1)}.json`
}
