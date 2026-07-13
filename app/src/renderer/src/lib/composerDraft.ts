/**
 * Per-(case, session) staged chat-composer text. A panel's `sendToAgent` verb
 * broadcasts `panels:draft`; the App-level subscriber stages the text here, and
 * ChatPane feeds it to the Composer as `prefill` so the user can review/edit and
 * send it — the panel never sends a turn on its own (mirrors the citations tray).
 */
const keyOf = (caseSlug: string, sessionId: number): string => `${caseSlug}#${sessionId}`

class ComposerDraft {
  private byKey = new Map<string, string>()
  private listeners = new Set<() => void>()

  /** The staged text for a (case, session), or undefined when nothing is staged. */
  get(caseSlug: string, sessionId: number): string | undefined {
    return this.byKey.get(keyOf(caseSlug, sessionId))
  }
  /** Stage text (replaces any previously-staged text for this case+session). */
  set(caseSlug: string, sessionId: number, text: string): void {
    this.byKey.set(keyOf(caseSlug, sessionId), text)
    this.emit()
  }
  /** Drop the staged text (e.g. after the user sends). No-op when nothing is staged. */
  clear(caseSlug: string, sessionId: number): void {
    if (this.byKey.delete(keyOf(caseSlug, sessionId))) this.emit()
  }
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}

export const composerDraft = new ComposerDraft()
