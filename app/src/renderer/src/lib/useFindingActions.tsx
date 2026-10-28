import { useState } from 'react'
import { findingsStore } from './findingsStore'
import { confirm } from './confirmStore'
import { stageCorrection } from './correctFinding'
import { FindingRejectStrip } from '../components/FindingRejectStrip'
import type { FindingRejectReason, FindingRole, FindingRow } from '../../../shared/observability'

/**
 * A finding card's own actions, shared by the rail (`FindingsPane`) and the Findings document:
 * review, chain edit and delete, the reject strip and the error line under the card. The store
 * owns the toggle semantics and the merge; this owns which card's strip is open, whether RULED OUT
 * is, and which card's error line shows. Per instance — the two surfaces do not share a strip.
 */
export function useFindingActions(
  slug: string,
  opts: {
    sessionId: number | null
    /** Whether the caller has a RULED OUT section a fresh reject moves the card into. */
    ruledOut: boolean
  }
): {
  rejectingId: number | null
  openStrip: (id: number) => void
  showRuledOut: boolean
  setShowRuledOut: React.Dispatch<React.SetStateAction<boolean>>
  editError: { id: number; message: string } | null
  setReview: (
    id: number,
    next: 'accepted' | 'rejected',
    reason?: FindingRejectReason
  ) => Promise<FindingRow | null>
  edit: (
    id: number,
    patch: { role?: FindingRole | null; causedBy?: number | null }
  ) => Promise<void>
  remove: (id: number) => Promise<void>
  /** The review walk's callbacks (`useReviewWalk`), so both surfaces walk with the same rules. */
  walk: {
    onAccept: (id: number) => Promise<FindingRow | null>
    onReject: (id: number) => Promise<FindingRow | null>
    onReopenStrip: (id: number) => void
    onClearStrip: () => void
    onError: (id: number, message: string) => void
  }
  /** The card's footer: its error line, then the reject strip unless `strip` is false. */
  footer: (f: FindingRow, o?: { strip?: boolean }) => React.ReactNode
} {
  const { sessionId, ruledOut } = opts
  const [rejectingId, setRejectingId] = useState<number | null>(null)
  const [showRuledOut, setShowRuledOut] = useState(false)
  const [editError, setEditError] = useState<{ id: number; message: string } | null>(null)

  /** Reject now, reason strip after (spec 2026-10-25 D3): a thumbs-down that lands on
   *  `rejected` opens the strip under that card; anything else — accept, a toggle back to
   *  pending, a reason pick — closes it. Nothing here blocks. */
  async function setReview(
    id: number,
    next: 'accepted' | 'rejected',
    reason?: FindingRejectReason
  ): Promise<FindingRow | null> {
    const row = await findingsStore.review(slug, id, next, reason)
    // A failed save must not discard the typed note: a reason pick that comes back null keeps
    // the strip open. Otherwise the strip is open only on a fresh reject with no reason yet.
    const keepOpen = reason ? row === null : row?.reviewState === 'rejected'
    setRejectingId(keepOpen ? id : null)
    // A rejected finding leaves its section for RULED OUT, which is collapsed by default: open
    // it, or the strip this reject just opened would render nowhere. A caller with no RULED OUT
    // section (the rail in review mode) must not leave it open for later.
    if (keepOpen && !reason && ruledOut) setShowRuledOut(true)
    return row
  }

  /** A refusal (a loop, a second root cause…) is the edited card's own line of text, never a
   *  dialog — the same as the inline chat card. */
  async function edit(
    id: number,
    patch: { role?: FindingRole | null; causedBy?: number | null }
  ): Promise<void> {
    setEditError(null)
    try {
      await findingsStore.update(slug, id, patch)
    } catch (err) {
      setEditError({ id, message: (err as Error).message })
    }
  }

  /** Per-finding hard delete: findings.md splice, DB row and audit all happen in main
   *  (deleteFinding); the store drops the row only on success. An unknown id, a second window's
   *  concurrent delete or an fs error is shown under the card, which stays. */
  async function remove(id: number): Promise<void> {
    const f = findingsStore.get(slug).rows.find((x) => x.id === id)
    const ok = await confirm({
      title: 'Delete finding?',
      message: f?.summary ?? `Finding ${id}`,
      danger: true
    })
    if (!ok) return
    setEditError(null)
    try {
      await findingsStore.remove(slug, id)
    } catch (err) {
      setEditError({ id, message: (err as Error).message })
    }
  }

  const walk = {
    onAccept: (id: number) => {
      setEditError(null)
      return setReview(id, 'accepted')
    },
    onReject: (id: number) => {
      setEditError(null)
      return setReview(id, 'rejected')
    },
    onReopenStrip: (id: number) => {
      // Already rejected: reopen the strip (under RULED OUT), do not toggle it back.
      setRejectingId(id)
      setShowRuledOut(true)
    },
    onClearStrip: () => setRejectingId(null),
    onError: (id: number, message: string) => setEditError({ id, message })
  }

  function footer(f: FindingRow, o?: { strip?: boolean }): React.ReactNode {
    const err = editError?.id === f.id ? editError.message : null
    const rejecting = (o?.strip ?? true) && rejectingId === f.id
    if (!err && !rejecting) return undefined
    return (
      <>
        {err && (
          <p role="alert" className="px-3 pb-1 text-[10.5px] text-danger">
            {err}
          </p>
        )}
        {rejecting && (
          <FindingRejectStrip
            onPick={(reason) => void setReview(f.id, 'rejected', reason)}
            onSkip={() => setRejectingId(null)}
            onCorrect={
              sessionId !== null ? () => stageCorrection(slug, sessionId, f.id) : undefined
            }
          />
        )}
      </>
    )
  }

  return {
    rejectingId,
    openStrip: setRejectingId,
    showRuledOut,
    setShowRuledOut,
    editError,
    setReview,
    edit,
    remove,
    walk,
    footer
  }
}
