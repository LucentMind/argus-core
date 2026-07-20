import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

export interface ConfirmOptions {
  /** Short question shown in the dialog header (e.g. `Delete case aaas?`). */
  title: ReactNode
  /** Consequence detail shown in the body. */
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Red destructive styling on the confirm button. */
  danger?: boolean
}

interface Pending extends ConfirmOptions {
  id: number
  resolve: (ok: boolean) => void
  /** alert() shows a single acknowledge button and no cancel. */
  acknowledge: boolean
}

interface State {
  current: Pending | null
}

/**
 * Imperative, promise-based replacement for `window.confirm` / `window.alert`.
 *
 * The native dialogs render in OS chrome (and the OS locale — that's why some
 * users saw a German "Abbrechen"). This store lets any call site `await confirm(…)`
 * while a single {@link ConfirmHost} mounted at the app root renders the prompt in
 * Argus's own modal styling. One prompt shows at a time; a newer request dismisses
 * an older one as cancelled.
 */
class ConfirmStore {
  private state: State = { current: null }
  private listeners = new Set<() => void>()
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

  request(opts: ConfirmOptions, acknowledge: boolean): Promise<boolean> {
    // A newer prompt supersedes whatever is on screen rather than stacking.
    this.state.current?.resolve(false)
    return new Promise<boolean>((resolve) => {
      this.set({ current: { ...opts, acknowledge, id: ++this.seq, resolve } })
    })
  }

  /** Resolve and dismiss the active prompt. The id guards against a stale click
   *  settling a prompt that was already replaced. */
  settle(id: number, ok: boolean): void {
    const cur = this.state.current
    if (!cur || cur.id !== id) return
    this.set({ current: null })
    cur.resolve(ok)
  }
}

export const confirmStore = new ConfirmStore()

export function useConfirmState(): State {
  return useSyncExternalStore(confirmStore.subscribe, confirmStore.get)
}

/** Ask the user to confirm a (usually destructive) action. Resolves true on confirm. */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return confirmStore.request(opts, false)
}

/** Single-button acknowledgement, replacing `window.alert`. Resolves when dismissed. */
export function alert(opts: Omit<ConfirmOptions, 'danger'> | string): Promise<void> {
  const o = typeof opts === 'string' ? { title: opts } : opts
  return confirmStore.request(o, true).then(() => undefined)
}
