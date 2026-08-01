import { useSyncExternalStore } from 'react'

export type NoticeTone = 'info' | 'danger'

export interface Notice {
  id: number
  message: string
  tone: NoticeTone
}

interface State {
  notices: Notice[]
}

/** How long a notice stays up before dismissing itself. */
export const NOTICE_TTL_MS = 6000

/**
 * Transient, non-blocking notices — the non-modal counterpart to {@link confirmStore}.
 *
 * It exists so one-shot messages (an export finished, a Jira sync failed) render inline in
 * the case header's info slot, right of the mode switch, rather than as a bottom-right toast
 * the user — reaching for the case menu up top — never noticed.
 *
 * No cap on the queue: only the newest notice is ever rendered (see `HeaderNotice`), so an
 * older, unseen entry sitting behind it costs nothing and each one still self-expires within
 * `NOTICE_TTL_MS` regardless of how many arrive.
 */
class NoticeStore {
  private state: State = { notices: [] }
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

  push(message: string, tone: NoticeTone): number {
    const id = ++this.seq
    const next = [...this.state.notices, { id, message, tone }]
    this.set({ notices: next })
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), NOTICE_TTL_MS)
    )
    return id
  }

  dismiss(id: number): void {
    this.clearTimer(id)
    const next = this.state.notices.filter((n) => n.id !== id)
    // No-op rather than notifying when nothing changed — a late timer for an
    // already-dismissed notice must not wake every subscriber.
    if (next.length === this.state.notices.length) return
    this.set({ notices: next })
  }

  private clearTimer(id: number): void {
    const t = this.timers.get(id)
    if (t !== undefined) {
      clearTimeout(t)
      this.timers.delete(id)
    }
  }

  /** Tests only: drop every notice and cancel every pending timer, so a fake-timer
   *  advance in a later test cannot fire a notice queued by an earlier one. */
  reset(): void {
    for (const id of [...this.timers.keys()]) this.clearTimer(id)
    this.set({ notices: [] })
  }
}

export const noticeStore = new NoticeStore()

export function useNotices(): State {
  return useSyncExternalStore(noticeStore.subscribe, noticeStore.get)
}

/** Show a transient, non-blocking notice. */
export function notice(message: string, tone: NoticeTone = 'info'): void {
  noticeStore.push(message, tone)
}
