import type { SnippetResult } from '../../../shared/snippets'

/** Renderer-side cache for CitationCard snippet previews. Keyed per citation;
 *  caching the promise dedupes concurrent expands of the same citation. */
const MAX_ENTRIES = 200
const cache = new Map<string, Promise<SnippetResult>>()
let subscribed = false

export function fetchSnippet(
  caseSlug: string,
  relPath: string,
  line: number
): Promise<SnippetResult> {
  if (!subscribed && window.argus?.evidence?.onChanged) {
    subscribed = true
    window.argus.evidence.onChanged((slug) => invalidateCase(slug))
  }
  const key = `${caseSlug}|${relPath}|${line}`
  const hit = cache.get(key)
  if (hit) return hit
  const p: Promise<SnippetResult> = window.argus.evidence
    .readSnippet(caseSlug, relPath, line)
    .catch(() => {
      // Transient IPC failures shouldn't stick, but only evict our own entry:
      // the key may have been invalidated and re-fetched while we were pending.
      if (cache.get(key) === p) cache.delete(key)
      return { ok: false, reason: 'not-found' } as const
    })
  cache.set(key, p)
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return p
}

export function invalidateCase(caseSlug: string): void {
  const prefix = `${caseSlug}|`
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k)
}

/** Test hook: reset all module state. */
export function clearSnippetCache(): void {
  cache.clear()
  subscribed = false
}
