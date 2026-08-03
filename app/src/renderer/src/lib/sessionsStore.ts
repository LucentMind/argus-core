import type { SessionSummary } from '../../../shared/types'

const EMPTY: SessionSummary[] = []

/**
 * Per-case chat list — the single source of truth for which chats a case has and what each
 * one is pinned to (provider instance, model, run options, permission mode).
 *
 * It is a store rather than lifted state because the two readers are not in a tidy
 * parent/child line: CaseWorkspace needs the ACTIVE row (the composer's chips are derived
 * from it) while SessionSwitcher — which sits two levels down, behind PanelTabStrip — needs
 * the whole list and is what mutates it (create/rename/delete). They each used to keep their
 * own `useState` copy, and only the switcher's copy was refreshed after creating a chat: the
 * workspace never learned the new row existed, `sessions.find(...)` returned undefined, and
 * the composer's model/run-option/permission chips silently refused to move until the user
 * left the case and came back (re-running the workspace's own `[slug]` load). One store, one
 * copy, no way for the two to disagree.
 */
class SessionsStore {
  private byCase = new Map<string, SessionSummary[]>()
  private listeners = new Set<() => void>()

  /** Stable snapshot for `useSyncExternalStore` — the same array reference until a write. */
  get(caseSlug: string): SessionSummary[] {
    return this.byCase.get(caseSlug) ?? EMPTY
  }

  /** Refetch a case's list. Resolves with it so callers that must act on the fresh rows
   *  (deleteChat picking the next chat to land on) don't need a second read. */
  async load(caseSlug: string): Promise<SessionSummary[]> {
    const list = await window.argus.sessions.list(caseSlug)
    this.byCase.set(caseSlug, list)
    this.emit()
    return list
  }

  /** Adopt a newly created chat without a round-trip. Deliberately synchronous: the caller
   *  selects this id immediately afterwards, and a row that arrives one `sessions.list` later
   *  is exactly the gap that left the composer's chips inert. Replaces any existing row with
   *  the same id, so it doubles as a refresh for one chat. */
  upsert(caseSlug: string, session: SessionSummary): void {
    const list = this.byCase.get(caseSlug) ?? EMPTY
    const i = list.findIndex((s) => s.id === session.id)
    this.byCase.set(
      caseSlug,
      i === -1 ? [...list, session] : list.map((s) => (s.id === session.id ? session : s))
    )
    this.emit()
  }

  /** Optimistic in-place edit of one chat, so a chip reflects a pick without waiting on the
   *  persist round-trip. A no-op when the row is unknown — callers pin a `sessionId` that
   *  came from this store, so that means the case has since been switched away from. */
  patch(caseSlug: string, sessionId: number, fields: Partial<SessionSummary>): void {
    const list = this.byCase.get(caseSlug)
    if (!list?.some((s) => s.id === sessionId)) return
    this.byCase.set(
      caseSlug,
      list.map((s) => (s.id === sessionId ? { ...s, ...fields } : s))
    )
    this.emit()
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Test hook. */
  clearForTests(): void {
    this.byCase.clear()
    this.listeners.clear()
  }

  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}

export const sessionsStore = new SessionsStore()
