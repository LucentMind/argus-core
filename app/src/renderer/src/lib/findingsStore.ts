import type { FindingRow, FindingRejectReason, ReviewState } from '../../../shared/observability'

export interface CaseFindings {
  rows: FindingRow[]
  /** True once the first list for this slug has settled (resolved OR rejected). */
  loaded: boolean
  /** The last list failure's message; cleared by the next success. */
  error: string | null
}

const EMPTY: CaseFindings = { rows: [], loaded: false, error: null }

/**
 * The one owner of a case's finding rows in the renderer. `FindingsPane` (the rail), the
 * inline chat card and anything else that shows a finding read it here, so a review made in one
 * place is on screen in every other place at once. Same shape as `reposStore`.
 *
 * A failed refetch never blanks rows already on screen: a rejected list has not established that
 * there are none (the rule FindingsPane carried before the store existed).
 */
class FindingsStore {
  private byCase = new Map<string, CaseFindings>()
  private listeners = new Set<() => void>()

  get(slug: string): CaseFindings {
    return this.byCase.get(slug) ?? EMPTY
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async load(slug: string): Promise<void> {
    try {
      const rows = await window.argus.findings.list(slug)
      this.set(slug, { rows, loaded: true, error: null })
    } catch (err) {
      const message = (err as Error).message
      console.warn(`[findings] list failed for ${slug}: ${message}`)
      this.set(slug, { ...this.get(slug), loaded: true, error: message })
    }
  }

  /**
   * Toggle semantics: clicking the active thumb returns the finding to pending. A call WITH a
   * reason never toggles — adding a reason to an already-rejected finding is the same state
   * again (spec 2026-10-25 §4.3). The returned row comes straight from the findings table with
   * no `body`, so it is MERGED onto the local row, never swapped in (the body would vanish).
   */
  async review(
    slug: string,
    id: number,
    next: 'accepted' | 'rejected',
    reason?: FindingRejectReason
  ): Promise<FindingRow | null> {
    const cur = this.get(slug).rows.find((f) => f.id === id)?.reviewState
    const state: ReviewState = cur === next && !reason ? 'pending' : next
    const row = await window.argus.findings.review(id, state, reason)
    if (row) this.merge(slug, row)
    return row
  }

  /** The main process has already spliced findings.md, deleted the row and audited it by the
   *  time this resolves; only then is the row dropped locally. The confirm stays in the caller. */
  async remove(slug: string, id: number): Promise<void> {
    await window.argus.findings.delete(id)
    this.set(slug, { ...this.get(slug), rows: this.get(slug).rows.filter((f) => f.id !== id) })
  }

  merge(slug: string, row: FindingRow): void {
    const cur = this.get(slug)
    this.set(slug, {
      ...cur,
      rows: cur.rows.map((f) => (f.id === row.id ? { ...f, ...row } : f))
    })
  }

  /** Test hook. */
  clearForTests(): void {
    this.byCase.clear()
    this.listeners.clear()
  }

  private set(slug: string, next: CaseFindings): void {
    this.byCase.set(slug, next)
    for (const cb of this.listeners) cb()
  }
}

export const findingsStore = new FindingsStore()

let wired = false
/** A finding the agent appends or updates refetches its case — the same two events that bump
 *  `agentStore.findingsBump`, read here directly so no component has to relay them. */
export function wireFindingsStore(): void {
  if (wired || typeof window === 'undefined' || !window.argus?.agent) return
  wired = true
  window.argus.agent.onEvent((e) => {
    if (e.type === 'case.finding.added' || e.type === 'case.finding.updated')
      void findingsStore.load(e.caseSlug)
  })
}
