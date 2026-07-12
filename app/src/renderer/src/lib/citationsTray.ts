export interface Citation {
  relPath: string
  line: number
}

const keyOf = (caseSlug: string, sessionId: number): string => `${caseSlug}#${sessionId}`

class CitationsTray {
  private byKey = new Map<string, Citation[]>()
  private listeners = new Set<() => void>()

  get(caseSlug: string, sessionId: number): Citation[] {
    return this.byKey.get(keyOf(caseSlug, sessionId)) ?? []
  }
  add(caseSlug: string, sessionId: number, c: Citation): void {
    const k = keyOf(caseSlug, sessionId)
    this.byKey.set(k, [...(this.byKey.get(k) ?? []), c])
    this.emit()
  }
  remove(caseSlug: string, sessionId: number, index: number): void {
    const k = keyOf(caseSlug, sessionId)
    const next = (this.byKey.get(k) ?? []).filter((_, i) => i !== index)
    this.byKey.set(k, next)
    this.emit()
  }
  clear(caseSlug: string, sessionId: number): void {
    this.byKey.set(keyOf(caseSlug, sessionId), [])
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

export const citationsTray = new CitationsTray()
