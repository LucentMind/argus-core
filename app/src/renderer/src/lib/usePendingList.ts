import { useCallback, useMemo, useState } from 'react'

/**
 * One in-flight operation the user can see: named before the work starts, because every caller
 * knows the name (a dropped filename, a picked repo's basename) before it calls main.
 */
export interface PendingEntry {
  /** Client-side identity, stable from `add` through `resolve`/`fail`. */
  id: string
  name: string
  /** Set by `fail`; the entry stays on screen carrying this message until dismissed. */
  error?: string
}

export interface PendingList {
  items: PendingEntry[]
  /** Register an entry and return its id. Call BEFORE the first await, or it is pointless. */
  add(name: string): string
  /** Success: drop these ids. */
  resolve(ids: string[]): void
  /** Failure: keep these ids on screen, carrying `message`. */
  fail(ids: string[], message: string): void
  /** The user clicked × on an error row. */
  dismiss(id: string): void
}

let seq = 0
const nextId = (): string => `pending-${++seq}`

/**
 * The pending-entry state machine shared by the action surfaces (evidence drop, repo link).
 * Extracted rather than written per component because `composerAttachments` already implements
 * this exact shape for the composer's paste path — these are the second and third call sites.
 *
 * Every mutation is a functional update, so a caller that adds several entries in one handler
 * (a multi-file drop) appends all of them rather than clobbering.
 */
export function usePendingList(): PendingList {
  const [items, setItems] = useState<PendingEntry[]>([])

  const add = useCallback((name: string): string => {
    const id = nextId()
    setItems((prev) => [...prev, { id, name }])
    return id
  }, [])

  const resolve = useCallback((ids: string[]): void => {
    const drop = new Set(ids)
    setItems((prev) => prev.filter((x) => !drop.has(x.id)))
  }, [])

  const fail = useCallback((ids: string[], message: string): void => {
    const hit = new Set(ids)
    setItems((prev) => prev.map((x) => (hit.has(x.id) ? { ...x, error: message } : x)))
  }, [])

  const dismiss = useCallback((id: string): void => {
    setItems((prev) => prev.filter((x) => x.id !== id))
  }, [])

  return useMemo(
    () => ({ items, add, resolve, fail, dismiss }),
    [items, add, resolve, fail, dismiss]
  )
}
