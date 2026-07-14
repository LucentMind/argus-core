import type { DatabaseSync } from 'node:sqlite'
import type { EvidenceRecord, SearchFilters, SearchHit } from '../../../shared/types'
import type { PanelPermission } from '../../../shared/panels'
import { getCase } from '../caseService'
import { searchEvidence, readEvidenceText } from '../search'
import { listEvidence } from '../ingest'

/** Practical ceiling for `bytes`-source ingests over IPC (spec §7); larger files should use `url`. */
const MAX_INGEST_BYTES = 25 * 1024 * 1024

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export interface PanelCaseContext {
  caseSlug: string
  caseId: number
  sessionId: number | null
  focus?: { evidenceId: number; line?: number }
}

export interface PanelEvidenceDoc {
  content: string
  relPath: string
  caseSlug: string
  startLine: number
  truncated: boolean
  focusLine?: number
}

/**
 * Registry metadata for one evidence item, projected for a panel (3d-3).
 * Deliberately narrower than EvidenceRecord: omits sha256, caseId, and the raw
 * meta bag; lifts meta.derivedFrom to a top-level derivedFrom for provenance.
 */
export interface EvidenceSummary {
  evidenceId: number
  relPath: string
  artifactType: string
  size: number
  origin: string
  derivedFrom?: number
  createdAt: string
}

/** Project a registry row to the panel-facing summary (3d-3). */
function toEvidenceSummary(rec: EvidenceRecord): EvidenceSummary {
  const derivedFrom = typeof rec.meta.derivedFrom === 'number' ? rec.meta.derivedFrom : undefined
  return {
    evidenceId: rec.id,
    relPath: rec.relPath,
    artifactType: rec.artifactType,
    size: rec.size,
    origin: rec.origin,
    ...(derivedFrom !== undefined ? { derivedFrom } : {}),
    createdAt: rec.createdAt
  }
}

/** Effectful sink the write verbs call. Injected by PanelHost so bridge.ts stays testable with a fake. */
export interface PanelWriteSink {
  /** Stage `text` into the bound session's chat composer for the user to review/send (not auto-sent). */
  sendToAgent(caseSlug: string, sessionId: number, text: string): void
  emitFinding(
    caseSlug: string,
    sessionId: number,
    input: { title: string; markdown: string }
  ): Promise<{ ok: boolean; findingId?: number }>
  cite(target: { caseSlug: string; sessionId: number }, relPath: string, line: number): void
  ingestEvidence(
    caseSlug: string,
    sessionId: number,
    input: { source: { url: string } | { bytes: Buffer }; filename: string }
  ): Promise<{ ok: true; evidenceId: string } | { ok: false; reason: string }>
}

/** The (partial) bridge exposed to a panel; only granted verbs are present. */
export interface PanelBridge {
  getCaseContext?(): PanelCaseContext
  requestEvidence?(query: string): SearchHit[]
  readEvidence?(evidenceId: number, focusLine?: number): PanelEvidenceDoc
  /** 3d-3: enumerate the bound case's evidence registry metadata (read-only, no bytes). */
  listCaseEvidence?(): EvidenceSummary[]
  sendToAgent?(text: string): { ok: true }
  emitFinding?(input: { title: string; markdown: string }): Promise<{ ok: boolean; findingId?: number }>
  cite?(relPath: string, line: number): { ok: true }
  ingestEvidence?(input: {
    source: { url: string } | { bytes: ArrayBuffer | Uint8Array }
    filename: string
  }): Promise<{ ok: true; evidenceId: string } | { ok: false; reason: string }>
}

export interface PanelBridgeBinding {
  db: DatabaseSync
  argusHome: string
  /** The one case this panel may read; enforced on every verb. */
  caseSlug: string
  permissions: PanelPermission[]
  /** The "Open in" focus target, surfaced via getCaseContext. */
  focus?: { evidenceId: number; line?: number }
  /** The renderer's active session for this case, when known. */
  sessionId?: number | null
  /** Effectful write sink (3b); write verbs are omitted when absent. */
  writeSink?: PanelWriteSink
  /** Declared network allowlist (3a `network[]`), reused to validate ingestEvidence `url` sources. */
  network?: string[]
}

const ALL: PanelPermission[] = [
  'getCaseContext',
  'requestEvidence',
  'readEvidence',
  'cite',
  'emitFinding',
  'sendToAgent',
  'readCaseFiles',
  'ingestEvidence',
  'listCaseEvidence'
]

/**
 * Build a case-bound, read-only bridge. The returned object contains ONLY the
 * verbs in `binding.permissions` (intersected with the 3a read set); every read
 * is scoped to `binding.caseSlug` — a panel can never reach another case.
 */
export function createPanelBridge(binding: PanelBridgeBinding): PanelBridge {
  const { db, argusHome, caseSlug } = binding
  const granted = new Set(binding.permissions.filter((p) => ALL.includes(p)))
  const bridge: PanelBridge = {}

  if (granted.has('getCaseContext')) {
    bridge.getCaseContext = (): PanelCaseContext => {
      const c = getCase(db, caseSlug)
      if (!c) throw new Error(`panel bound to unknown case: ${caseSlug}`)
      return {
        caseSlug: c.slug,
        caseId: c.id,
        sessionId: binding.sessionId ?? null,
        focus: binding.focus
      }
    }
  }

  if (granted.has('requestEvidence')) {
    bridge.requestEvidence = (query: string): SearchHit[] => {
      const filters: SearchFilters = { caseSlug } // case-bound; never other cases
      return searchEvidence(db, query, filters)
    }
  }

  if (granted.has('readEvidence')) {
    bridge.readEvidence = (evidenceId: number, focusLine?: number): PanelEvidenceDoc => {
      const doc = readEvidenceText(db, argusHome, evidenceId, focusLine)
      if (doc.caseSlug !== caseSlug) {
        throw new Error(`evidence ${evidenceId} is not in case ${caseSlug}`)
      }
      return {
        content: doc.content,
        relPath: doc.relPath,
        caseSlug: doc.caseSlug,
        startLine: doc.startLine,
        truncated: doc.truncated,
        focusLine
      }
    }
  }

  if (granted.has('listCaseEvidence')) {
    // Metadata-only enumeration of the bound case (3d-3). listEvidence() is already
    // case-scoped in SQL and newest-first; we only project each row to the narrow summary.
    bridge.listCaseEvidence = (): EvidenceSummary[] =>
      listEvidence(db, caseSlug).map(toEvidenceSummary)
  }

  const sink = binding.writeSink
  const sessionId = binding.sessionId ?? null
  const requireSession = (): number => {
    if (sessionId == null) throw new Error(`panel has no bound session (case ${caseSlug})`)
    return sessionId
  }

  if (sink && granted.has('sendToAgent')) {
    bridge.sendToAgent = (text: string): { ok: true } => {
      sink.sendToAgent(caseSlug, requireSession(), text)
      return { ok: true }
    }
  }

  if (sink && granted.has('emitFinding')) {
    bridge.emitFinding = (input: { title: string; markdown: string }) =>
      sink.emitFinding(caseSlug, requireSession(), input)
  }

  if (sink && granted.has('cite')) {
    bridge.cite = (relPath: string, line: number): { ok: true } => {
      sink.cite({ caseSlug, sessionId: requireSession() }, relPath, line)
      return { ok: true }
    }
  }

  if (sink && granted.has('ingestEvidence')) {
    bridge.ingestEvidence = async (input) => {
      const sid = requireSession()
      // Reject any path separator or traversal in the panel-supplied filename — it is joined
      // under the case evidence dir downstream with no basename/.. guard (ingest.ts). A bare
      // name only. Blocks '/', '\', '', '.', '..' regardless of platform.
      if (
        /[\\/]/.test(input.filename) ||
        input.filename === '' ||
        input.filename === '.' ||
        input.filename === '..'
      ) {
        return { ok: false, reason: 'invalid-filename' }
      }
      if ('url' in input.source) {
        const reqOrigin = originOf(input.source.url)
        const allowed =
          reqOrigin !== null && (binding.network ?? []).some((o) => originOf(o) === reqOrigin)
        if (!allowed) return { ok: false, reason: 'origin-not-allowed' }
        return sink.ingestEvidence(caseSlug, sid, {
          source: { url: input.source.url },
          filename: input.filename
        })
      }
      const bytes = input.source.bytes
      const len = bytes.byteLength
      if (len > MAX_INGEST_BYTES) return { ok: false, reason: 'bytes-too-large' }
      return sink.ingestEvidence(caseSlug, sid, {
        source: { bytes: Buffer.from(bytes as ArrayBuffer) },
        filename: input.filename
      })
    }
  }

  return bridge
}
