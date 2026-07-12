import type { DatabaseSync } from 'node:sqlite'
import type { SearchFilters, SearchHit } from '../../../shared/types'
import type { PanelPermission } from '../../../shared/panels'
import { getCase } from '../caseService'
import { searchEvidence, readEvidenceText } from '../search'

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

/** The (partial) read-only bridge exposed to a panel; only granted verbs are present. */
export interface PanelBridge {
  getCaseContext?(): PanelCaseContext
  requestEvidence?(query: string): SearchHit[]
  readEvidence?(evidenceId: number, focusLine?: number): PanelEvidenceDoc
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
}

const ALL: PanelPermission[] = ['getCaseContext', 'requestEvidence', 'readEvidence']

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

  return bridge
}
