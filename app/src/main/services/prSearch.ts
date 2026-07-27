import type { DatabaseSync } from 'node:sqlite'
import {
  classifyCandidates,
  remoteToOwnerRepo,
  type RawPrHit,
  type PrSearchResult
} from '../../shared/pr'
import { getCase } from './caseService'
import { listStoredWorkspaces } from './workspaces'
import { defaultGhRunner, type Runner } from './github'

/** Re-exported so existing importers of `prSearch`'s Runner keep working. */
export type { Runner }

export interface PrSearchDeps {
  db: DatabaseSync
  gh?: Runner
}

// A captured search took ~5.4s; 20s leaves headroom without hanging a background task.
const SEARCH_TIMEOUT_MS = 20_000

/**
 * Candidate PRs for a case, found by searching its linked GitHub repos for the ticket
 * key. NEVER THROWS — every failure is reported in `error` so a mode switch and the
 * manual-linking fallback are never blocked.
 */
export async function searchPrsForCase(
  deps: PrSearchDeps,
  caseSlug: string
): Promise<PrSearchResult> {
  const empty: PrSearchResult = { candidates: [], error: null, searchedRepos: [] }
  let repos: string[]
  let key: string
  try {
    const kase = getCase(deps.db, caseSlug)
    if (!kase?.jiraKey) return empty // nothing to search for — not an error
    key = kase.jiraKey
    // Scoped to linked repos: review mode requires a local clone to make a worktree
    // from, so a PR in an unlinked repo is out of scope by design.
    repos = [
      ...new Set(
        listStoredWorkspaces(deps.db, caseSlug)
          .map((w) => (w.remote ? remoteToOwnerRepo(w.remote) : null))
          .filter((r): r is { owner: string; repo: string } => r !== null)
          .map((r) => `${r.owner}/${r.repo}`)
      )
    ]
  } catch (err) {
    return { candidates: [], error: (err as Error).message, searchedRepos: [] }
  }
  if (!repos.length) return empty

  // --match title deliberately: a ticket key in a PR body or comment usually means
  // "related to", not "fixes". See specs/2026-07-26-github-pr-detection-design.md.
  const args = [
    'search',
    'prs',
    key,
    '--match',
    'title',
    '--limit',
    '30',
    '--json',
    'number,state,isDraft,title,createdAt,url,repository'
  ]
  for (const r of repos) args.push('--repo', r)

  let stdout: string
  try {
    stdout = await (deps.gh ?? defaultGhRunner)('gh', args, { timeoutMs: SEARCH_TIMEOUT_MS })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return {
      candidates: [],
      error: e.code === 'ENOENT' ? 'GitHub CLI (gh) is not installed' : e.message,
      searchedRepos: repos
    }
  }
  try {
    return {
      candidates: classifyCandidates(JSON.parse(stdout) as RawPrHit[]),
      error: null,
      searchedRepos: repos
    }
  } catch {
    return { candidates: [], error: 'gh returned unreadable JSON', searchedRepos: repos }
  }
}
