/**
 * Parses whatever the user typed into an explicit provider + provider-native ref.
 *
 * Inferring the provider from *typed input* is safe: it is the user's own text, disambiguated
 * at the moment of choice, and the resolved provider is shown in the preview before anything
 * is created. What must never happen is re-deriving the provider from a STORED ref — that is
 * what `cases.ticket_provider` is for.
 *
 * Pure. No I/O. Importable from both main and renderer (hence `shared/`, not `main/`).
 */
export type TicketProviderId = 'jira' | 'github'

export interface TicketRef {
  provider: TicketProviderId
  /** Provider-native ref: `PROJ-123` for Jira, `owner/repo#123` for GitHub. */
  ref: string
}

export type ParsedTicketRef = { ok: true; value: TicketRef } | { ok: false; error: string }

/** Jira's one real link shape (`/browse/<KEY>`), as `jiraKeyInput.ts` established. */
const JIRA_BROWSE_URL = /^https?:\/\/[^/\s]+\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/i
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/
const OWNER_REPO = String.raw`([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)`
const GH_ISSUE_URL = new RegExp(
  `^https?://github\\.com/${OWNER_REPO}/issues/(\\d+)(?:[/?#].*)?$`,
  'i'
)
const GH_PULL_URL = new RegExp(`^https?://github\\.com/${OWNER_REPO}/pull/(\\d+)(?:[/?#].*)?$`, 'i')
const GH_SHORT = new RegExp(`^${OWNER_REPO}#(\\d+)$`)
const GH_SHORT_NO_NUMBER = new RegExp(`^${OWNER_REPO}$`)

export function parseTicketRef(input: string): ParsedTicketRef {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, error: 'Enter a ticket key, issue ref, or URL.' }

  const browse = JIRA_BROWSE_URL.exec(trimmed)
  if (browse) return { ok: true, value: { provider: 'jira', ref: browse[1] } }

  const pull = GH_PULL_URL.exec(trimmed)
  if (pull) {
    return {
      ok: false,
      error: `${pull[1]}/${pull[2]}#${pull[3]} is a pull request, not an issue.`
    }
  }

  const issueUrl = GH_ISSUE_URL.exec(trimmed)
  if (issueUrl) {
    return {
      ok: true,
      value: { provider: 'github', ref: ghRef(issueUrl[1], issueUrl[2], issueUrl[3]) }
    }
  }

  const short = GH_SHORT.exec(trimmed)
  if (short) {
    return { ok: true, value: { provider: 'github', ref: ghRef(short[1], short[2], short[3]) } }
  }

  if (JIRA_KEY.test(trimmed)) return { ok: true, value: { provider: 'jira', ref: trimmed } }

  if (/^#\d+$/.test(trimmed)) {
    return { ok: false, error: 'Include the repository: owner/repo#123.' }
  }
  if (GH_SHORT_NO_NUMBER.test(trimmed) && trimmed.includes('/')) {
    return { ok: false, error: `Add the issue number: ${trimmed}#123.` }
  }

  // Unrecognised: hand it to Jira unchanged, exactly as `parseJiraKeyInput` does today, so a
  // typo produces Jira's own "not found" rather than a parser message about a provider the
  // user may not even use.
  return { ok: true, value: { provider: 'jira', ref: trimmed } }
}

const ghRef = (owner: string, repo: string, number: string): string => `${owner}/${repo}#${number}`

export function splitGithubRef(ref: string): { owner: string; repo: string; number: number } {
  const m = GH_SHORT.exec(ref)
  if (!m) throw new Error(`Not a GitHub ref: ${ref}`)
  return { owner: m[1], repo: m[2], number: Number(m[3]) }
}
