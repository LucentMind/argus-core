import { describe, expect, it } from 'vitest'
import { createCtx } from '../ctx.mjs'
import { bucketOfCheckRun, buildSyntheticStatus, rollupOf } from '../prs.mjs'

describe('createCtx', () => {
  const ctx = createCtx({ argusHome: 'C:/home', db: null })

  it('lists the five slugs in roster order', () => {
    expect(ctx.SLUGS).toEqual([
      'HMT-1-burst-token',
      'HMT-2-green',
      'HMT-3-cancelled',
      'HMT-4-nochecks',
      'SYN-5-edge'
    ])
  })

  it('maps every slug to its pull request number', () => {
    expect(ctx.PR_NUMBERS).toEqual({
      'HMT-1-burst-token': 4,
      'HMT-2-green': 6,
      'HMT-3-cancelled': 7,
      'HMT-4-nochecks': 5,
      'SYN-5-edge': 999
    })
  })

  it('builds the worktree path the app computes', () => {
    expect(ctx.worktreeDir('hmt', 'HMT-1-burst-token', 4).replace(/\\/g, '/')).toBe(
      'C:/home/worktrees/hmt-HMT-1-burst-token-pr4'
    )
  })
})

describe('bucketOfCheckRun', () => {
  it('treats anything not COMPLETED as pending', () => {
    expect(bucketOfCheckRun('IN_PROGRESS', null)).toBe('pending')
    expect(bucketOfCheckRun('QUEUED', 'SUCCESS')).toBe('pending')
  })

  it('separates cancelled and stale from failure', () => {
    expect(bucketOfCheckRun('COMPLETED', 'CANCELLED')).toBe('cancelled')
    expect(bucketOfCheckRun('COMPLETED', 'STALE')).toBe('cancelled')
    expect(bucketOfCheckRun('COMPLETED', 'FAILURE')).toBe('fail')
  })

  it('counts NEUTRAL as a pass and an unknown conclusion as a failure', () => {
    expect(bucketOfCheckRun('COMPLETED', 'NEUTRAL')).toBe('pass')
    expect(bucketOfCheckRun('COMPLETED', 'SOMETHING_NEW')).toBe('fail')
    expect(bucketOfCheckRun('COMPLETED', null)).toBe('fail')
  })

  it('reports SKIPPED as its own bucket', () => {
    expect(bucketOfCheckRun('COMPLETED', 'SKIPPED')).toBe('skipped')
  })
})

describe('rollupOf', () => {
  it('is none for an empty check list', () => {
    expect(rollupOf([])).toBe('none')
  })

  it('gates everything when nothing is required', () => {
    const checks = [
      { name: 'a', bucket: 'fail', required: false, url: null, jobId: null },
      { name: 'b', bucket: 'pass', required: false, url: null, jobId: null }
    ]
    expect(rollupOf(checks)).toBe('failing')
  })

  it('is unstable when the only failure is not required', () => {
    const checks = [
      { name: 'a', bucket: 'fail', required: false, url: null, jobId: null },
      { name: 'b', bucket: 'pass', required: true, url: null, jobId: null }
    ]
    expect(rollupOf(checks)).toBe('unstable')
  })

  it('ranks a failure above a pending check', () => {
    const checks = [
      { name: 'a', bucket: 'fail', required: false, url: null, jobId: null },
      { name: 'b', bucket: 'pending', required: true, url: null, jobId: null },
      { name: 'c', bucket: 'pass', required: true, url: null, jobId: null }
    ]
    expect(rollupOf(checks)).toBe('unstable')
  })
})

describe('buildSyntheticStatus', () => {
  const status = buildSyntheticStatus({ now: '2026-07-30T10:00:00.000Z' })

  it('covers every check bucket in one list', () => {
    expect(new Set(status.checks.map((c) => c.bucket))).toEqual(
      new Set(['pass', 'fail', 'cancelled', 'pending', 'skipped'])
    )
  })

  it('rolls up to unstable because the failure is not required', () => {
    expect(status.rollup).toBe('unstable')
    expect(status.checks.find((c) => c.bucket === 'fail').required).toBe(false)
  })

  it('carries one check whose log is unfetchable', () => {
    expect(status.checks.some((c) => c.jobId === null && c.url !== null)).toBe(true)
  })

  it('is a draft, conflicting, changes-requested pull request', () => {
    expect(status.isDraft).toBe(true)
    expect(status.mergeable).toBe('CONFLICTING')
    expect(status.reviewDecision).toBe('CHANGES_REQUESTED')
    expect(status.mergeStateStatus).toBe('BLOCKED')
  })
})
