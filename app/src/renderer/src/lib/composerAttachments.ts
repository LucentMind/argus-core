/**
 * Pending composer attachments, keyed per (case, session) like `citationsTray` —
 * `Composer` is keyed `${slug}#${sessionId}` in ChatPane and remounts on session
 * switch, so tray state has to outlive the component.
 *
 * Unlike citations, entries are addressed by `id` rather than index: ingest is
 * async, so an entry's position can shift between render and click.
 */
export interface Attachment {
  /** Client-side identity, stable from paste through ingest. */
  id: string
  /** Display name — the local filename while pending, the evidence name once ready. */
  name: string
  status: 'pending' | 'ready' | 'error'
  /** Set once ingested, e.g. `evidence/screenshot-2026-07-20-143052.png`. */
  relPath?: string
  /** Object URL for an image preview; revoked by the tray on unmount. */
  previewUrl?: string
  /** Failure message, shown on the error chip. */
  error?: string
}

const keyOf = (caseSlug: string, sessionId: number): string => `${caseSlug}#${sessionId}`

// useSyncExternalStore requires a referentially stable snapshot when nothing changed.
const EMPTY: Attachment[] = []

class ComposerAttachments {
  private byKey = new Map<string, Attachment[]>()
  private listeners = new Set<() => void>()

  get(caseSlug: string, sessionId: number): Attachment[] {
    return this.byKey.get(keyOf(caseSlug, sessionId)) ?? EMPTY
  }
  add(caseSlug: string, sessionId: number, a: Attachment): void {
    const k = keyOf(caseSlug, sessionId)
    this.byKey.set(k, [...(this.byKey.get(k) ?? []), a])
    this.emit()
  }
  update(caseSlug: string, sessionId: number, id: string, patch: Partial<Attachment>): void {
    const k = keyOf(caseSlug, sessionId)
    const current = this.byKey.get(k) ?? []
    if (!current.some((a) => a.id === id)) return // stale id: the user removed it mid-ingest
    this.byKey.set(
      k,
      current.map((a) => (a.id === id ? { ...a, ...patch } : a))
    )
    this.emit()
  }
  remove(caseSlug: string, sessionId: number, id: string): void {
    const k = keyOf(caseSlug, sessionId)
    const current = this.byKey.get(k) ?? []
    if (!current.some((a) => a.id === id)) return // stale id: already removed
    this.byKey.set(
      k,
      current.filter((a) => a.id !== id)
    )
    this.emit()
  }
  clear(caseSlug: string, sessionId: number): void {
    const k = keyOf(caseSlug, sessionId)
    const current = this.byKey.get(k)
    if (!current || current.length === 0) return // no-op when already empty
    this.byKey.set(k, [])
    this.emit()
  }
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}

export const composerAttachments = new ComposerAttachments()
