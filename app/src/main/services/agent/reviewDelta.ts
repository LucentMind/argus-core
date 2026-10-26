// app/src/main/services/agent/reviewDelta.ts
import type { FindingRow } from '../../../shared/observability'
import type { ModeId } from '../../../shared/modes'
import type { PromptTextSpecs } from '../../../shared/promptSpec'
import { fillPrompt } from '../prompts/fill'

/**
 * Everything the agent reads about human reviews made between its turns. Registered in the
 * prompts registry under `turn.review-delta.*` (and this file is in coverage.test's SCANNED
 * list), so wording is overridable like every other model-facing string.
 */
export const REVIEW_DELTA_PROMPTS: PromptTextSpecs = {
  preamble: {
    title: 'Review delta — preamble',
    text: "[Finding reviews since your last turn — the user's judgement on findings you recorded. An ACCEPTED finding is settled unless the user reopens it. A REJECTED finding is ruled out; its reason says how — do not record it again and do not restate it as a conclusion. Call list_findings for the full picture.]"
  },
  accepted: {
    title: 'Review delta — accepted line',
    text: '- Finding #{id} "{summary}" — ACCEPTED by the user.',
    placeholders: ['id', 'summary']
  },
  rejected: {
    title: 'Review delta — rejected line',
    text: '- Finding #{id} "{summary}" — REJECTED by the user ({why}).',
    placeholders: ['id', 'summary', 'why']
  },
  cleared: {
    title: 'Review delta — review cleared line',
    text: '- Finding #{id} "{summary}" — review cleared by the user (back to unreviewed).',
    placeholders: ['id', 'summary']
  },
  'no-reason': {
    title: 'Review delta — untagged reject',
    text: 'no reason given'
  }
}

type Resolve = (id: string) => string

const text = (key: string, resolve?: Resolve): string =>
  resolve ? resolve(`turn.review-delta.${key}`) : REVIEW_DELTA_PROMPTS[key].text

/** One line per reviewed finding, from the row's CURRENT state. */
export function renderReviewDeltaLine(row: FindingRow, resolve?: Resolve): string {
  const vars = { id: String(row.id), summary: row.summary }
  switch (row.reviewState) {
    case 'accepted':
      return fillPrompt(text('accepted', resolve), vars)
    case 'rejected': {
      const why = row.rejectTag
        ? row.rejectNote
          ? `${row.rejectTag}: ${row.rejectNote}`
          : row.rejectTag
        : text('no-reason', resolve)
      return fillPrompt(text('rejected', resolve), { ...vars, why })
    }
    default:
      return fillPrompt(text('cleared', resolve), vars)
  }
}

/**
 * Per-case queue of human reviews the agent has not been told about yet (spec 2026-10-26 §5.3).
 * `note` records the row's latest state (last review of a finding wins); `drain` renders the
 * block a session of `mode` prefixes to its next driver send and forgets exactly what it
 * rendered. In-memory on purpose: a note lost to a restart costs one `list_findings` call, and a
 * persisted queue would need its own lifecycle. Keyed by caseId because that is what
 * `CaseSession` and `FindingRow` both carry.
 */
export class ReviewDeltaQueue {
  private byCase = new Map<number, Map<number, FindingRow>>()

  note(row: FindingRow): void {
    const entries = this.byCase.get(row.caseId) ?? new Map<number, FindingRow>()
    entries.set(row.id, row)
    this.byCase.set(row.caseId, entries)
  }

  /** The block for the next turn of a `mode` session of this case, or '' when nothing waits.
   *  A review-mode session never hears about investigation findings and vice versa. */
  drain(caseId: number, mode: ModeId, resolve?: Resolve): string {
    const entries = this.byCase.get(caseId)
    if (!entries) return ''
    const lines: string[] = []
    for (const [id, row] of entries) {
      if (row.mode !== mode) continue
      lines.push(renderReviewDeltaLine(row, resolve))
      entries.delete(id)
    }
    if (entries.size === 0) this.byCase.delete(caseId)
    if (lines.length === 0) return ''
    return `${text('preamble', resolve)}\n${lines.join('\n')}\n\n`
  }

  /** Drop one finding's pending note (the finding itself was deleted). */
  forget(caseId: number, findingId: number): void {
    const entries = this.byCase.get(caseId)
    if (!entries) return
    entries.delete(findingId)
    if (entries.size === 0) this.byCase.delete(caseId)
  }

  /** Drop a case's pending notes — only `mode`'s when given (a mode-scoped findings clear),
   *  else all of them (case close). */
  clear(caseId: number, mode?: ModeId): void {
    if (mode === undefined) {
      this.byCase.delete(caseId)
      return
    }
    const entries = this.byCase.get(caseId)
    if (!entries) return
    for (const [id, row] of entries) if (row.mode === mode) entries.delete(id)
    if (entries.size === 0) this.byCase.delete(caseId)
  }
}
