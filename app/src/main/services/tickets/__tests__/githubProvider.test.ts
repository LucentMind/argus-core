import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { createGithubProvider } from '../githubProvider'
import type { Runner } from '../../github'

/** Real `gh issue view` output shape, captured 2026-08-27 against cli/cli (spec §3). */
const ISSUE = {
  number: 14189,
  title: 'Fix Copilot declined-install warning newline',
  body: 'Steps to reproduce:\n\n1. run gh',
  state: 'CLOSED',
  stateReason: 'COMPLETED',
  author: { login: 'mislav' },
  createdAt: '2026-08-19T10:00:00Z',
  updatedAt: '2026-08-21T17:56:37Z',
  labels: [{ name: 'bug' }, { name: 'p1' }],
  url: 'https://github.com/cli/cli/issues/14189',
  closedByPullRequestsReferences: [
    {
      id: 'PR_kwDODKw3uc8AAAABAlTbMA',
      number: 14222,
      repository: {
        id: 'MDEwOlJlcG9zaXRvcnkyMTI2MTMwNDk=',
        name: 'cli',
        owner: { id: 'MDEyOk9yZ2FuaXphdGlvbjU5NzA0NzEx', login: 'cli' }
      },
      url: 'https://github.com/cli/cli/pull/14222'
    }
  ],
  comments: [
    {
      id: 'MDEyOklzc3VlQ29tbWVudDU0MDU1MTk2OQ==',
      author: { login: 'mislav' },
      body: 'This branch was already merged.',
      createdAt: '2019-10-10T12:35:44Z',
      url: 'https://github.com/cli/cli/issues/14189#issuecomment-540551969'
    }
  ]
}

const runnerFor = (payload: unknown): Runner =>
  vi.fn(async () => JSON.stringify(payload)) as unknown as Runner

describe('githubProvider.getIssue', () => {
  it('maps a closed-completed issue onto the preview shape', async () => {
    const p = createGithubProvider({ gh: runnerFor(ISSUE) })
    const { preview, descriptionMarkdown } = await p.getIssue('cli/cli#14189')
    expect(preview.provider).toBe('github')
    expect(preview.key).toBe('cli/cli#14189')
    expect(preview.summary).toBe('Fix Copilot declined-install warning newline')
    expect(preview.status).toBe('closed')
    expect(preview.priority).toBeNull()
    expect(preview.labels).toEqual(['bug', 'p1'])
    expect(preview.reporter).toBe('mislav')
    expect(preview.attachments).toEqual([])
    expect(preview.cloneLinks).toEqual([])
    expect(preview.created).toBe('2026-08-19T10:00:00Z')
    expect(preview.updated).toBe('2026-08-21T17:56:37Z')
    expect(preview.url).toBe('https://github.com/cli/cli/issues/14189')
    expect(descriptionMarkdown).toBe('Steps to reproduce:\n\n1. run gh')
  })

  it('calls gh with the split ref', async () => {
    const gh = runnerFor(ISSUE)
    await createGithubProvider({ gh }).getIssue('cli/cli#14189')
    const [cmd, args] = (gh as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(cmd).toBe('gh')
    expect(args.slice(0, 4)).toEqual(['issue', 'view', '14189', '--repo'])
    expect(args[4]).toBe('cli/cli')
  })

  it('renders NOT_PLANNED as a distinct status', async () => {
    const p = createGithubProvider({
      gh: runnerFor({ ...ISSUE, state: 'CLOSED', stateReason: 'NOT_PLANNED' })
    })
    expect((await p.getIssue('cli/cli#1')).preview.status).toBe('closed (not planned)')
  })

  it('renders DUPLICATE as a distinct status', async () => {
    const p = createGithubProvider({
      gh: runnerFor({ ...ISSUE, state: 'CLOSED', stateReason: 'DUPLICATE' })
    })
    expect((await p.getIssue('cli/cli#1')).preview.status).toBe('closed (duplicate)')
  })

  it('treats an empty stateReason as plain closed', async () => {
    // Real older issues return "" — not null, not COMPLETED (spec §3 finding 3).
    const p = createGithubProvider({
      gh: runnerFor({ ...ISSUE, state: 'CLOSED', stateReason: '' })
    })
    expect((await p.getIssue('cli/cli#1')).preview.status).toBe('closed')
  })

  it('renders an open issue as open', async () => {
    const p = createGithubProvider({
      gh: runnerFor({ ...ISSUE, state: 'OPEN', stateReason: '' })
    })
    expect((await p.getIssue('cli/cli#1')).preview.status).toBe('open')
  })

  it('rejects a ref that resolves to a pull request', async () => {
    // gh issue view happily returns PRs — verified: `gh issue view 9 --repo cli/cli`.
    const p = createGithubProvider({
      gh: runnerFor({ ...ISSUE, url: 'https://github.com/cli/cli/pull/9' })
    })
    await expect(p.getIssue('cli/cli#9')).rejects.toThrow(/pull request, not an issue/i)
  })

  it('adopts the canonical ref when the issue was transferred', async () => {
    const p = createGithubProvider({
      gh: runnerFor({ ...ISSUE, number: 42, url: 'https://github.com/cli/go-gh/issues/42' })
    })
    const { preview } = await p.getIssue('cli/cli#14189')
    expect(preview.key).toBe('cli/go-gh#42')
  })
})

describe('githubProvider.getComments', () => {
  it('maps comments onto the shared comment shape', async () => {
    const p = createGithubProvider({ gh: runnerFor(ISSUE) })
    const comments = await p.getComments('cli/cli#14189')
    expect(comments).toEqual([
      {
        id: 'MDEyOklzc3VlQ29tbWVudDU0MDU1MTk2OQ==',
        author: 'mislav',
        created: '2019-10-10T12:35:44Z',
        // GitHub exposes no per-comment edit timestamp, so updated mirrors created and the
        // rendered markdown shows no "(edited)" marker rather than a wrong one.
        updated: '2019-10-10T12:35:44Z',
        bodyMarkdown: 'This branch was already merged.'
      }
    ])
  })
})

describe('githubProvider.linkedPrs', () => {
  it('maps closing references into candidates, lowercasing gh pr view state', async () => {
    // gh pr view returns UPPERCASE state ("MERGED"), gh search prs returns lowercase, and
    // PrCandidate['state'] is the lowercase union. Verified 2026-08-27.
    const gh = vi.fn(async (_cmd: string, args: string[]) =>
      args[0] === 'issue'
        ? JSON.stringify(ISSUE)
        : JSON.stringify({
            number: 14222,
            state: 'MERGED',
            isDraft: false,
            title: 'Fix Copilot declined-install warning newline',
            createdAt: '2026-08-21T17:56:37Z',
            url: 'https://github.com/cli/cli/pull/14222'
          })
    ) as unknown as Runner
    const prs = await createGithubProvider({ gh }).linkedPrs('cli/cli#14189')
    expect(prs).toEqual([
      {
        owner: 'cli',
        repo: 'cli',
        number: 14222,
        url: 'https://github.com/cli/cli/pull/14222',
        title: 'Fix Copilot declined-install warning newline',
        state: 'merged',
        isDraft: false,
        createdAt: '2026-08-21T17:56:37Z',
        // A closing reference is declared structured data, not a title heuristic: the Jira
        // backport rules must not be ported over.
        isBackport: false,
        preselected: true
      }
    ])
  })

  it('drops a closed-never-merged reference', async () => {
    const gh = vi.fn(async (_cmd: string, args: string[]) =>
      args[0] === 'issue'
        ? JSON.stringify(ISSUE)
        : JSON.stringify({
            number: 14222,
            state: 'CLOSED',
            isDraft: false,
            title: 'abandoned',
            createdAt: '2026-08-21T17:56:37Z',
            url: 'https://github.com/cli/cli/pull/14222'
          })
    ) as unknown as Runner
    expect(await createGithubProvider({ gh }).linkedPrs('cli/cli#14189')).toEqual([])
  })

  it('returns [] when the issue has no closing references', async () => {
    const p = createGithubProvider({
      gh: runnerFor({ ...ISSUE, closedByPullRequestsReferences: [] })
    })
    expect(await p.linkedPrs('cli/cli#14189')).toEqual([])
  })

  it('keeps an OPEN linked PR reference', async () => {
    // closedByPullRequestsReferences is populated on open issues too and can point at a
    // not-yet-merged PR; the state === 'closed' filter must let OPEN through.
    const gh = vi.fn(async (_cmd: string, args: string[]) =>
      args[0] === 'issue'
        ? JSON.stringify(ISSUE)
        : JSON.stringify({
            number: 14222,
            state: 'OPEN',
            isDraft: false,
            title: 'Fix Copilot declined-install warning newline',
            createdAt: '2026-08-21T17:56:37Z',
            url: 'https://github.com/cli/cli/pull/14222'
          })
    ) as unknown as Runner
    const prs = await createGithubProvider({ gh }).linkedPrs('cli/cli#14189')
    expect(prs).toHaveLength(1)
    expect(prs[0].state).toBe('open')
  })

  it('isolates a failed reference so the others still return', async () => {
    // Two closing references; the first gh pr view call throws (deleted/private repo,
    // transient network error). The failure must not discard the second, already-resolvable
    // reference — the caller degrades a *total* failure to "no candidates", so one bad
    // reference must not cost every other linked PR.
    const ISSUE_TWO_REFS = {
      ...ISSUE,
      closedByPullRequestsReferences: [
        {
          id: 'PR_bad',
          number: 1,
          repository: { id: 'r1', name: 'cli', owner: { id: 'o1', login: 'cli' } },
          url: 'https://github.com/cli/cli/pull/1'
        },
        {
          id: 'PR_good',
          number: 14222,
          repository: { id: 'r2', name: 'cli', owner: { id: 'o2', login: 'cli' } },
          url: 'https://github.com/cli/cli/pull/14222'
        }
      ]
    }
    let prCalls = 0
    const gh = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'issue') return JSON.stringify(ISSUE_TWO_REFS)
      prCalls++
      if (prCalls === 1) throw new Error('gh: repository not found (private or deleted)')
      return JSON.stringify({
        number: 14222,
        state: 'MERGED',
        isDraft: false,
        title: 'Fix Copilot declined-install warning newline',
        createdAt: '2026-08-21T17:56:37Z',
        url: 'https://github.com/cli/cli/pull/14222'
      })
    }) as unknown as Runner
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prs = await createGithubProvider({ gh }).linkedPrs('cli/cli#14189')
    warnSpy.mockRestore()
    expect(prs).toEqual([
      {
        owner: 'cli',
        repo: 'cli',
        number: 14222,
        url: 'https://github.com/cli/cli/pull/14222',
        title: 'Fix Copilot declined-install warning newline',
        state: 'merged',
        isDraft: false,
        createdAt: '2026-08-21T17:56:37Z',
        isBackport: false,
        preselected: true
      }
    ])
  })
})

describe('githubProvider.postComment', () => {
  it('posts via --body-file, never --body', async () => {
    const gh = vi.fn(
      async () => 'https://github.com/cli/cli/issues/14189#issuecomment-1'
    ) as unknown as Runner
    await createGithubProvider({ gh }).postComment('cli/cli#14189', '# report\n\nsome body')
    const [cmd, args] = (gh as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(cmd).toBe('gh')
    expect(args.slice(0, 4)).toEqual(['issue', 'comment', '14189', '--repo'])
    expect(args[4]).toBe('cli/cli')
    expect(args).toContain('--body-file')
    expect(args).not.toContain('--body')
  })

  it('writes the exact markdown to the file passed to --body-file', async () => {
    const markdown = '# report\n\nsome **body** with `code`'
    let capturedContents: string | undefined
    const gh = vi.fn(async (_cmd: string, args: string[]) => {
      const file = args[args.indexOf('--body-file') + 1]
      capturedContents = fs.readFileSync(file, 'utf8')
      return 'https://github.com/cli/cli/issues/14189#issuecomment-1'
    }) as unknown as Runner
    await createGithubProvider({ gh }).postComment('cli/cli#14189', markdown)
    expect(capturedContents).toBe(markdown)
  })

  it('returns the URL parsed out of gh stdout', async () => {
    const gh = vi.fn(
      async () => 'some preamble https://github.com/cli/cli/issues/14189#issuecomment-42 trailer'
    ) as unknown as Runner
    const { url } = await createGithubProvider({ gh }).postComment('cli/cli#14189', 'body')
    expect(url).toBe('https://github.com/cli/cli/issues/14189#issuecomment-42')
  })

  it('falls back to the issue web URL when stdout carries no URL', async () => {
    const gh = vi.fn(async () => 'no url here') as unknown as Runner
    const { url } = await createGithubProvider({ gh }).postComment('cli/cli#14189', 'body')
    expect(url).toBe('https://github.com/cli/cli/issues/14189')
  })

  it('removes the temp directory even when the gh call throws', async () => {
    let capturedDir: string | undefined
    const gh = vi.fn(async (_cmd: string, args: string[]) => {
      const file = args[args.indexOf('--body-file') + 1]
      capturedDir = path.dirname(file)
      expect(fs.existsSync(capturedDir)).toBe(true)
      throw new Error('gh: network error')
    }) as unknown as Runner
    await expect(createGithubProvider({ gh }).postComment('cli/cli#14189', 'body')).rejects.toThrow(
      /network error/
    )
    expect(capturedDir).toBeDefined()
    expect(fs.existsSync(capturedDir!)).toBe(false)
  })
})

describe('githubProvider.webUrl', () => {
  it('builds the issue URL from the ref', () => {
    expect(createGithubProvider({}).webUrl('cli/cli#14189')).toBe(
      'https://github.com/cli/cli/issues/14189'
    )
  })
})
