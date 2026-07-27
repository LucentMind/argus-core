/**
 * Pull-request types shared by main and renderer. Pure — no `node:*` or Electron
 * imports (see the shared/ constraint).
 */

/** A PR bound to a case. `repoPath` is the local clone, when the case has one linked. */
export interface PrBinding {
  id: number
  caseId: number
  repoPath: string | null
  owner: string
  repo: string
  number: number
  url: string
  /**
   * How the binding came to exist. Only these two: detection is a GitHub search run
   * from inside review mode, never a Jira ticket create/refresh hook — see
   * specs/2026-07-26-github-pr-detection-design.md.
   */
  source: 'manual' | 'search'
  detectedAt: string
}

export type NewPrBinding = Omit<PrBinding, 'id' | 'caseId' | 'detectedAt'>

/** A PR identified well enough to bind it. */
export interface PrRef {
  owner: string
  repo: string
  number: number
  url: string
}

const OWNER_REPO = '([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+?)'

// git@github.com:owner/repo(.git) | https://github.com/owner/repo(.git) |
// ssh://git@github.com/owner/repo — trailing slash and .git suffix both optional.
const REMOTE_RE = new RegExp(
  `^(?:git@|(?:https?|ssh|git)://(?:[^@/]+@)?)github\\.com[:/]${OWNER_REPO}(?:\\.git)?/?$`,
  'i'
)

/** `owner`/`repo` for a GitHub remote url; null for any other host or junk. */
export function remoteToOwnerRepo(remote: string): { owner: string; repo: string } | null {
  const m = REMOTE_RE.exec(remote.trim())
  return m ? { owner: m[1], repo: m[2] } : null
}

function canonicalUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/pull/${number}`
}

const PR_URL_RE = new RegExp(
  `^(?:https?://)?(?:www\\.)?github\\.com/${OWNER_REPO}/pull/(\\d+)\\b`,
  'i'
)
const OWNER_REPO_HASH_RE = new RegExp(`^${OWNER_REPO}#(\\d+)$`)
const BARE_NUMBER_RE = /^#?(\d+)$/

/**
 * A PR url, `owner/repo#N`, or a bare `N` resolved against `fallbackRemote`. The returned
 * `url` is always canonical so bindings dedupe regardless of how they were typed.
 */
export function parsePrRef(input: string, fallbackRemote?: string | null): PrRef | null {
  const raw = input.trim()
  if (!raw) return null

  const url = PR_URL_RE.exec(raw)
  if (url) {
    const number = Number(url[3])
    return { owner: url[1], repo: url[2], number, url: canonicalUrl(url[1], url[2], number) }
  }

  const hash = OWNER_REPO_HASH_RE.exec(raw)
  if (hash) {
    const number = Number(hash[3])
    return { owner: hash[1], repo: hash[2], number, url: canonicalUrl(hash[1], hash[2], number) }
  }

  const bare = BARE_NUMBER_RE.exec(raw)
  if (bare) {
    const or = fallbackRemote ? remoteToOwnerRepo(fallbackRemote) : null
    if (!or) return null
    const number = Number(bare[1])
    return { ...or, number, url: canonicalUrl(or.owner, or.repo, number) }
  }

  return null
}

/** One hit from `gh search prs --json …`, exactly as gh emits it. */
export interface RawPrHit {
  number: number
  state: string // 'open' | 'closed' | 'merged' — gh normalizes merged out of closed
  isDraft: boolean
  title: string
  createdAt: string
  url: string
  repository: { nameWithOwner: string }
}

export interface PrCandidate {
  owner: string
  repo: string
  number: number
  url: string
  title: string
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  createdAt: string
  /** Title matches the backport prefix — shown, but not pre-selected. */
  isBackport: boolean
  /**
   * Candidate for the picker's default RADIO selection (a case binds at most one PR, so
   * only the first `preselected` hit is actually used — see PrPickerDialog's `defaultKey`).
   * Never a binding decision on its own: a miss just costs the user one click.
   */
  preselected: boolean
}

export interface PrSearchResult {
  candidates: PrCandidate[]
  /** Non-null when the search could not run; candidates is then empty. */
  error: string | null
  /** `owner/repo` actually searched, so an empty state can name them. */
  searchedRepos: string[]
}

// Backport PRs in this codebase's convention prefix the title, e.g.
// "[Backport release/v0.26] [NN-5165] …". Labels are NOT usable: the primary PR
// carries `backport release/*` labels (requests to backport) while a real backport
// may carry none. See specs/2026-07-26-github-pr-detection-design.md.
const BACKPORT_TITLE = /^\s*\[backport\b/i

export function classifyCandidates(raw: RawPrHit[]): PrCandidate[] {
  return raw
    .filter((h) => h.state !== 'closed') // closed-and-never-merged is not reviewable
    .map((h) => {
      const [owner, repo] = h.repository.nameWithOwner.split('/')
      const isBackport = BACKPORT_TITLE.test(h.title)
      return {
        owner,
        repo,
        number: h.number,
        url: h.url,
        title: h.title,
        state: h.state as PrCandidate['state'],
        isDraft: h.isDraft,
        createdAt: h.createdAt,
        isBackport,
        // Every non-backport is marked preselected: nothing in gh's available fields ranks
        // relevance among them (recency is inverted by backports). Only the FIRST
        // `preselected` hit becomes the picker's radio default (a case binds at most one
        // PR, so there is no "over-selection" to fall back on) — see PrPickerDialog.
        preselected: !isBackport
      }
    })
}
