import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { JiraCommentInfo } from '../../../shared/jira'
import type { PrCandidate } from '../../../shared/pr'
import { splitGithubRef } from '../../../shared/ticketRef'
import type { TicketIssueData, TicketPreview } from '../../../shared/tickets'
import { defaultGhRunner, GH_TIMEOUT_MS, type Runner } from '../github'
import type { TicketProvider } from './provider'

/** Exactly the fields `gh issue view --json` is asked for. */
interface GhIssue {
  number: number
  title: string
  body: string
  state: string
  stateReason: string
  author: { login: string } | null
  createdAt: string
  updatedAt: string
  labels: { name: string }[]
  url: string
  closedByPullRequestsReferences: {
    number: number
    url: string
    repository: { name: string; owner: { login: string } }
  }[]
  comments: {
    id: string
    author: { login: string } | null
    body: string
    createdAt: string
  }[]
}

const ISSUE_FIELDS = [
  'number',
  'title',
  'body',
  'state',
  'stateReason',
  'author',
  'createdAt',
  'updatedAt',
  'labels',
  'url',
  'closedByPullRequestsReferences',
  'comments'
].join(',')

/**
 * `state` + `stateReason` → the string that lands in `cases.jira_status`.
 *
 * `stateReason` is NOT a two-valued enum: real values include COMPLETED, NOT_PLANNED,
 * DUPLICATE and "" (empty string on older issues — verified 2026-08-27). Anything other
 * than COMPLETED/"" renders as a parenthesised reason, so a reason GitHub adds later shows
 * up sensibly without a code change.
 */
export function ticketStatus(state: string, stateReason: string): string {
  if (state.toUpperCase() !== 'CLOSED') return state.toLowerCase()
  const reason = (stateReason ?? '').toUpperCase()
  if (reason === '' || reason === 'COMPLETED') return 'closed'
  return `closed (${reason.toLowerCase().replace(/_/g, ' ')})`
}

/** `https://github.com/o/r/issues/12` → `o/r#12`. Null when the URL is not an issue URL. */
function refFromIssueUrl(url: string): string | null {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i.exec(url)
  return m ? `${m[1]}/${m[2]}#${m[3]}` : null
}

export function createGithubProvider(deps: { gh?: Runner }): TicketProvider {
  const gh = deps.gh ?? defaultGhRunner
  const run = (args: string[]): Promise<string> => gh('gh', args, { timeoutMs: GH_TIMEOUT_MS })

  const fetchIssue = async (ref: string): Promise<GhIssue> => {
    const { owner, repo, number } = splitGithubRef(ref)
    const out = await run([
      'issue',
      'view',
      String(number),
      '--repo',
      `${owner}/${repo}`,
      '--json',
      ISSUE_FIELDS
    ])
    const issue = JSON.parse(out) as GhIssue
    // GitHub numbers issues and PRs in ONE sequence and `gh issue view` resolves both, so a
    // well-formed ref can return the wrong kind of object. The response URL is the only
    // reliable discriminator — the input cannot be checked for this.
    if (!refFromIssueUrl(issue.url)) {
      throw new Error(`${ref} is a pull request, not an issue.`)
    }
    return issue
  }

  const toPreview = (issue: GhIssue): TicketPreview => ({
    provider: 'github',
    // The CANONICAL ref from the response, not the requested one: a transferred issue
    // redirects, and the case must follow it rather than keep naming the old repo.
    key: refFromIssueUrl(issue.url)!,
    summary: issue.title,
    status: ticketStatus(issue.state, issue.stateReason),
    // GitHub has no priority. A labels→priority mapping is a guess that is wrong for most
    // repos, and the card already renders nothing for null.
    priority: null,
    labels: issue.labels.map((l) => l.name),
    reporter: issue.author?.login ?? null,
    created: issue.createdAt,
    updated: issue.updatedAt,
    // Attachments are a later increment: GitHub has no attachment API, only markdown links.
    attachments: [],
    cloneLinks: [],
    url: issue.url
  })

  return {
    id: 'github',

    async getIssue(ref: string): Promise<TicketIssueData> {
      const issue = await fetchIssue(ref)
      return { preview: toPreview(issue), descriptionMarkdown: issue.body ?? '', raw: issue }
    },

    async getComments(ref: string): Promise<JiraCommentInfo[]> {
      const issue = await fetchIssue(ref)
      return issue.comments.map((c) => ({
        id: c.id,
        author: c.author?.login ?? null,
        created: c.createdAt,
        // No per-comment edit timestamp exists on GitHub; mirroring `created` means the
        // rendered markdown shows no "(edited)" marker rather than a wrong one.
        updated: c.createdAt,
        bodyMarkdown: c.body ?? ''
      }))
    },

    async postComment(ref: string, markdown: string): Promise<{ url: string }> {
      const { owner, repo, number } = splitGithubRef(ref)
      const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'argus-gh-comment-')),
        'comment.md'
      )
      fs.writeFileSync(file, markdown, 'utf8')
      try {
        const out = await run([
          'issue',
          'comment',
          String(number),
          '--repo',
          `${owner}/${repo}`,
          // --body-file, never --body: a report is far past any command-line length limit.
          '--body-file',
          file
        ])
        const url = /https?:\/\/\S+/.exec(out)?.[0]
        return { url: url ?? this.webUrl(ref) }
      } finally {
        fs.rmSync(path.dirname(file), { recursive: true, force: true })
      }
    },

    webUrl(ref: string): string {
      const { owner, repo, number } = splitGithubRef(ref)
      return `https://github.com/${owner}/${repo}/issues/${number}`
    },

    async linkedPrs(ref: string): Promise<PrCandidate[]> {
      const issue = await fetchIssue(ref)
      const out: PrCandidate[] = []
      for (const r of issue.closedByPullRequestsReferences) {
        const owner = r.repository.owner.login
        const repo = r.repository.name
        // The reference carries only number/url/repository — state, title, isDraft and
        // createdAt need their own call (verified 2026-08-27).
        const detail = JSON.parse(
          await run([
            'pr',
            'view',
            String(r.number),
            '--repo',
            `${owner}/${repo}`,
            '--json',
            'number,state,isDraft,title,createdAt,url'
          ])
        ) as { state: string; isDraft: boolean; title: string; createdAt: string; url: string }
        // gh pr view returns UPPERCASE state; PrCandidate['state'] is the lowercase union
        // that gh search prs produces. Not lowercasing here yields a candidate whose state
        // never matches any renderer branch.
        const state = detail.state.toLowerCase() as PrCandidate['state']
        if (state === 'closed') continue // closed-and-never-merged is not reviewable
        out.push({
          owner,
          repo,
          number: r.number,
          url: detail.url,
          title: detail.title,
          state,
          isDraft: detail.isDraft,
          createdAt: detail.createdAt,
          isBackport: false,
          preselected: true
        })
      }
      return out
    }
  }
}
