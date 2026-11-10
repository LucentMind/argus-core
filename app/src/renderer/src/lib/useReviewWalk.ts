import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { findingsStore } from './findingsStore'
import type { FindingRow } from '../../../shared/observability'
import type { FindingTree } from '../../../shared/findingTree'

export interface Walk {
  ids: number[]
  i: number
}

/**
 * The Review walk (spec 2026-10-26 §5.4, lifted out of FindingsPane in §9.6): pending cards in
 * tree order, one expanded at a time, driven by `a` accept · `r` reject · `s`/`j` next · `k`
 * back · `Escape` done. Pane state over the caller's cards — no modal. The caller owns the
 * strip and the sections and gets told through the callbacks; the hook owns the ids, the index,
 * the key table, the scroll-into-view and the end-on-mode-switch rule, so the rail and the
 * Findings document walk identically. A walk is per instance: it does not carry across the two.
 */
export function useReviewWalk(opts: {
  slug: string
  /** `null` outside investigation mode: the walk ends and cannot start. */
  tree: FindingTree<FindingRow> | null
  listRef: RefObject<HTMLElement | null>
  onExpand: (id: number | null) => void
  onAccept: (id: number) => Promise<FindingRow | null>
  onReject: (id: number) => Promise<FindingRow | null>
  onReopenStrip: (id: number) => void
  onClearStrip: () => void
  onError: (id: number, message: string) => void
}): {
  walk: Walk | null
  current: number | null
  start: () => void
  end: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
} {
  const {
    slug,
    tree,
    listRef,
    onExpand,
    onAccept,
    onReject,
    onReopenStrip,
    onClearStrip,
    onError
  } = opts
  const [walk, setWalk] = useState<Walk | null>(null)
  // The ref mirrors the state so a key handler resolving after an await reads the walk as it is
  // now, not as it was when the key landed.
  const walkRef = useRef<Walk | null>(null)
  useLayoutEffect(() => {
    walkRef.current = walk
  }, [walk])
  // Investigation-only: the tree going away (a mode switch) ends it, and a switch back does not
  // resume it. Adjust-state-during-render, same idiom FindingsPane used for walkMode.
  const [hadTree, setHadTree] = useState(tree !== null)
  if ((tree !== null) !== hadTree) {
    setHadTree(tree !== null)
    if (tree === null && walk) setWalk(null)
  }
  const current = walk ? walk.ids[walk.i] : null
  // A long list puts the next card below the fold: bring the current card into view after the
  // commit that expanded it. `?.` because jsdom has no scrollIntoView.
  useEffect(() => {
    if (current === null) return
    listRef.current
      ?.querySelector<HTMLElement>(`li[data-finding-id="${current}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [current, listRef])

  /** Pending cards in tree order, captured once: a card the walk accepts or rejects keeps its
   *  slot, so `i of n` never shifts under the user. */
  function start(): void {
    if (!tree) return
    const ids = [...tree.rootCause, ...tree.unexplained]
      .filter((n) => n.row.reviewState === 'pending')
      .map((n) => n.row.id)
    if (ids.length === 0) return
    setWalk({ ids, i: 0 })
    onExpand(ids[0])
    onClearStrip()
    listRef.current?.focus()
  }
  function end(): void {
    setWalk(null)
    onExpand(null)
    onClearStrip()
  }
  /** Forward past the last card ends the walk; back stops at the first. */
  function step(delta: number): void {
    const w = walkRef.current
    if (!w) return
    const i = Math.max(0, w.i + delta)
    onClearStrip()
    if (i >= w.ids.length) {
      setWalk(null)
      onExpand(null)
      return
    }
    setWalk({ ...w, i })
    onExpand(w.ids[i])
  }
  function onKeyDown(e: React.KeyboardEvent): void {
    const w = walkRef.current
    // The reject strip handles its own Escape (skip) and marks it handled.
    if (!w || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')
      return
    const cur = w.ids[w.i]
    // The walk SETS a state; the store's review() toggles. Read the row fresh (not from this
    // render's closure) and never call the review when the row is already in the target state,
    // or a revisit (k, then a) would flip an accepted finding back to pending.
    const curState = findingsStore.get(slug).rows.find((f) => f.id === cur)?.reviewState
    switch (e.key) {
      case 'a':
        e.preventDefault()
        if (curState === 'accepted') {
          step(1)
          break
        }
        // Advance only if the walk is still on this card when the save lands (a fast `s` or
        // Escape in between already moved it), and only if the save landed at all: a refusal
        // (null) or a rejection stays on the card, the rejection's text on the card.
        onAccept(cur).then(
          (saved) => {
            const now = walkRef.current
            if (saved && now && now.ids[now.i] === cur) step(1)
          },
          (err: unknown) => onError(cur, (err as Error).message)
        )
        break
      case 'r':
        e.preventDefault()
        if (curState === 'rejected') onReopenStrip(cur)
        else onReject(cur).catch((err: unknown) => onError(cur, (err as Error).message))
        break
      case 's':
      case 'j':
        e.preventDefault()
        step(1)
        break
      case 'k':
        e.preventDefault()
        step(-1)
        break
      case 'Escape':
        e.preventDefault()
        // "Done" collapses the current card too, on both surfaces (the pane used to leave it
        // open; the document would otherwise keep one card open among open bodies).
        setWalk(null)
        onExpand(null)
        onClearStrip()
        break
    }
  }
  return { walk, current, start, end, onKeyDown }
}
