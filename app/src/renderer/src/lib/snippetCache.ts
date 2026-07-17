import type { RepoSnippetResult, SnippetResult } from '../../../shared/snippets'

/** What a CitationCard points at. Evidence = case files; repo = linked
 *  workspace code, resolved main-side against the tree the case sees. */
export type CiteSource =
  | { kind: 'evidence'; caseSlug: string; relPath: string }
  | { kind: 'repo'; caseSlug: string; repoName: string; relPath: string }

export type AnySnippetResult = SnippetResult | RepoSnippetResult

/** Renderer-side cache for CitationCard snippet previews. Keyed per citation;
 *  caching the promise dedupes concurrent expands of the same citation. */
const MAX_ENTRIES = 200
const cache = new Map<string, Promise<AnySnippetResult>>()
let subscribed = false

function keyOf(source: CiteSource, start: number, end: number): string {
  return source.kind === 'evidence'
    ? `e|${source.caseSlug}|${source.relPath}|${start}-${end}`
    : `r|${source.caseSlug}|${source.repoName}|${source.relPath}|${start}-${end}`
}

export function fetchSnippet(
  source: CiteSource,
  start: number,
  end: number
): Promise<AnySnippetResult> {
  if (!subscribed && window.argus?.evidence?.onChanged) {
    subscribed = true
    window.argus.evidence.onChanged((slug) => invalidateCase(slug))
  }
  const key = keyOf(source, start, end)
  const hit = cache.get(key)
  if (hit) return hit
  const request: Promise<AnySnippetResult> =
    source.kind === 'evidence'
      ? window.argus.evidence.readSnippet(source.caseSlug, source.relPath, start, end)
      : window.argus.workspaces.readSnippet(
          source.caseSlug,
          source.repoName,
          source.relPath,
          start,
          end
        )
  const p: Promise<AnySnippetResult> = request.catch(() => {
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

/** Evidence keys only — fired by evidence.onChanged broadcasts. */
export function invalidateCase(caseSlug: string): void {
  const prefix = `e|${caseSlug}|`
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k)
}

/** Repo keys only — call after linking/unlinking a repo for the case. */
export function invalidateRepoSnippets(caseSlug: string): void {
  const prefix = `r|${caseSlug}|`
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k)
}

/** Test hook: reset all module state. */
export function clearSnippetCache(): void {
  cache.clear()
  subscribed = false
}
