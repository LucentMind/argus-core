import { describe, it, expect } from 'vitest'
import {
  prHead,
  postInlineComment,
  postIssueComment,
  ghErrorText,
  isLineNotInDiff,
  type Runner
} from '../github'

describe('prHead', () => {
  it('asks gh for the head ref, sha and cross-repository flag', async () => {
    let seen: string[] = []
    const run: Runner = async (_cmd, args) => {
      seen = args
      return JSON.stringify({
        headRefName: 'feature/fix-guard',
        headRefOid: 'abc123',
        isCrossRepository: false
      })
    }
    const head = await prHead(run, 'acme/widget', 42)
    expect(head).toEqual({ ref: 'feature/fix-guard', sha: 'abc123', isCrossRepository: false })
    expect(seen).toEqual([
      'pr',
      'view',
      '42',
      '--repo',
      'acme/widget',
      '--json',
      'headRefName,headRefOid,isCrossRepository'
    ])
  })

  it('reports a fork PR', async () => {
    const run: Runner = async () =>
      JSON.stringify({ headRefName: 'patch-1', headRefOid: 'def456', isCrossRepository: true })
    expect((await prHead(run, 'acme/widget', 7)).isCrossRepository).toBe(true)
  })
})

describe('postInlineComment', () => {
  it('POSTs to the pulls comments endpoint with a typed line and RIGHT side', async () => {
    let seen: string[] = []
    const run: Runner = async (_cmd, args) => {
      seen = args
      return JSON.stringify({ html_url: 'https://github.com/acme/widget/pull/42#discussion_r1' })
    }
    const url = await postInlineComment(run, {
      repo: 'acme/widget',
      number: 42,
      commitId: 'abc123',
      path: 'src/guard.ts',
      line: 17,
      body: 'This guard is inverted.'
    })
    expect(url).toBe('https://github.com/acme/widget/pull/42#discussion_r1')
    expect(seen).toEqual([
      'api',
      '--method',
      'POST',
      'repos/acme/widget/pulls/42/comments',
      '-f',
      'commit_id=abc123',
      '-f',
      'path=src/guard.ts',
      '-F',
      'line=17',
      '-f',
      'side=RIGHT',
      '-f',
      'body=This guard is inverted.'
    ])
  })
})

describe('postIssueComment', () => {
  it('POSTs to the issues comments endpoint', async () => {
    let seen: string[] = []
    const run: Runner = async (_cmd, args) => {
      seen = args
      return JSON.stringify({ html_url: 'https://github.com/acme/widget/pull/42#issuecomment-9' })
    }
    const url = await postIssueComment(run, { repo: 'acme/widget', number: 42, body: 'note' })
    expect(url).toBe('https://github.com/acme/widget/pull/42#issuecomment-9')
    expect(seen).toEqual([
      'api',
      '--method',
      'POST',
      'repos/acme/widget/issues/42/comments',
      '-f',
      'body=note'
    ])
  })
})

describe('error helpers', () => {
  it('names a missing CLI', () => {
    expect(ghErrorText(Object.assign(new Error('spawn gh'), { code: 'ENOENT' }))).toBe(
      'GitHub CLI (gh) is not installed'
    )
  })

  it('prefers stderr over the generic message', () => {
    const err = Object.assign(new Error('Command failed'), { stderr: '  HTTP 404: Not Found  ' })
    expect(ghErrorText(err)).toBe('HTTP 404: Not Found')
  })

  it('detects the line-not-in-diff rejection', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: 'HTTP 422: line must be part of the diff'
    })
    expect(isLineNotInDiff(err)).toBe(true)
    expect(isLineNotInDiff(Object.assign(new Error('x'), { stderr: 'HTTP 404' }))).toBe(false)
  })

  // The shape a real `gh api` emits today, captured verbatim on 2026-07-29 against a live 422:
  // stderr carries only the generic line, and the API's sub-errors — the only place the anchor
  // failure is identifiable — are a JSON body on STDOUT. "part of the diff" appears in neither
  // stream, which is why the stderr-text match alone left the PR-level fallback dead in the
  // real app while every fake-Runner test stayed green.
  it('detects the rejection in the real gh error shape (sub-errors on stdout)', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: 'gh: Validation Failed (HTTP 422)',
      stdout:
        '{"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment","code":"custom","field":"pull_request_review_thread.line","message":"could not be resolved"}],"documentation_url":"https://docs.github.com/rest/pulls/comments#create-a-review-comment-for-a-pull-request","status":"422"}'
    })
    expect(isLineNotInDiff(err)).toBe(true)
  })

  it('does not treat other 422 validation failures as line-not-in-diff', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: 'gh: Validation Failed (HTTP 422)',
      stdout:
        '{"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment","code":"custom","field":"body","message":"too long"}],"status":"422"}'
    })
    expect(isLineNotInDiff(err)).toBe(false)
    expect(
      isLineNotInDiff(
        Object.assign(new Error('x'), {
          stderr: 'gh: Validation Failed (HTTP 422)',
          stdout: 'not json'
        })
      )
    ).toBe(false)
  })
})
