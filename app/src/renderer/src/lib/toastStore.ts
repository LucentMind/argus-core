import { useSyncExternalStore } from 'react'

export type ToastTone = 'info' | 'danger'

export interface Toast {
  id: number
  message: string
  tone: ToastTone
}

interface State {
  toasts: Toast[]
}

/** How long a toast stays up before dismissing itself. */
export const TOAST_TTL_MS = 6000

/** Beyond this the oldest is dropped rather than stacking off the bottom of the window. */
const MAX_TOASTS = 3

/**
 * Transient, non-blocking notices — the non-modal counterpart to {@link confirmStore}.
 *
 * It exists so one-shot messages (an export finished, a Jira sync failed) stop living as
 * inline strings in the case header, where their appearance reflowed every control to
 * their right while the user was already reaching for one of them.
 */
class ToastStore {
  private state: State = { toasts: [] }
  private listeners = new Set<() => void>()
  private timers = new Map<number, ReturnType<typeof setTimeout>>()
  private seq = 0

  get = (): State => this.state
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  private set(s: State): void {
    this.state = s
    for (const cb of this.listeners) cb()
  }

  push(message: string, tone: ToastTone): number {
    const id = ++this.seq
    const next = [...this.state.toasts, { id, message, tone }]
    // Clear the dropped toast's timer as well as removing it: a timer left running would
    // later call dismiss() for an id that is no longer on screen, which is harmless today
    // but becomes a stale-write the moment ids are ever reused.
    while (next.length > MAX_TOASTS) {
      const dropped = next.shift()
      if (dropped) this.clearTimer(dropped.id)
    }
    this.set({ toasts: next })
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), TOAST_TTL_MS)
    )
    return id
  }

  dismiss(id: number): void {
    this.clearTimer(id)
    const next = this.state.toasts.filter((t) => t.id !== id)
    // No-op rather than notifying when nothing changed — a late timer for an
    // already-dismissed toast must not wake every subscriber.
    if (next.length === this.state.toasts.length) return
    this.set({ toasts: next })
  }

  private clearTimer(id: number): void {
    const t = this.timers.get(id)
    if (t !== undefined) {
      clearTimeout(t)
      this.timers.delete(id)
    }
  }

  /** Tests only: drop every toast and cancel every pending timer, so a fake-timer
   *  advance in a later test cannot fire a toast queued by an earlier one. */
  reset(): void {
    for (const id of [...this.timers.keys()]) this.clearTimer(id)
    this.set({ toasts: [] })
  }
}

export const toastStore = new ToastStore()

export function useToasts(): State {
  return useSyncExternalStore(toastStore.subscribe, toastStore.get)
}

/** Show a transient, non-blocking notice. */
export function toast(message: string, tone: ToastTone = 'info'): void {
  toastStore.push(message, tone)
}
