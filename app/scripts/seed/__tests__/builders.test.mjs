import { describe, expect, it } from 'vitest'
import { createCtx } from '../ctx.mjs'
import { bucketOfCheckRun, buildSyntheticStatus, rollupOf, statusFromGh } from '../prs.mjs'
import { buildFlagshipFindings, buildThinFindings } from '../findings.mjs'
import { buildTrees } from '../files.mjs'

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

describe('statusFromGh', () => {
  // Hand-built `gh pr view --json statusCheckRollup` payload covering both
  // node typenames the field can contain.
  const raw = {
    number: 4,
    url: 'https://github.com/JiaweiHan88/HiveMindTest/pull/4',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'unit-tests',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl:
          'https://github.com/JiaweiHan88/HiveMindTest/actions/runs/30500000001/job/90600000001'
      },
      {
        __typename: 'StatusContext',
        context: 'netlify/deploy-preview',
        state: 'FAILURE',
        targetUrl: 'https://app.netlify.com/sites/demo/deploys/abc123'
      }
    ]
  }

  const status = statusFromGh(raw, {
    owner: 'JiaweiHan88',
    repo: 'HiveMindTest',
    number: 4,
    now: '2026-07-30T10:00:00.000Z'
  })

  it('buckets the CheckRun entry via bucketOfCheckRun', () => {
    const check = status.checks.find((c) => c.name === 'unit-tests')
    expect(check.bucket).toBe('pass')
  })

  it('buckets the StatusContext entry via bucketOfStatusContext', () => {
    const check = status.checks.find((c) => c.name === 'netlify/deploy-preview')
    expect(check.bucket).toBe('fail')
  })

  it('falls back to context for the StatusContext name and targetUrl for its url', () => {
    const check = status.checks[1]
    expect(check.name).toBe('netlify/deploy-preview')
    expect(check.url).toBe('https://app.netlify.com/sites/demo/deploys/abc123')
  })

  it('populates jobId for the Actions check and nulls it for the third-party one', () => {
    expect(status.checks[0].jobId).toBe(90600000001)
    expect(status.checks[1].jobId).toBeNull()
  })

  it('derives rollup from the projected checks rather than hardcoding it', () => {
    // Both checks are marked not-required (gh reports no per-PR branch protection),
    // so with nothing required everything gates, and the one failure makes it 'failing'.
    expect(rollupOf(status.checks)).toBe('failing')
    expect(status.rollup).toBe(rollupOf(status.checks))
    expect(status.rollup).toBe('failing')
  })
})

describe('buildFlagshipFindings', () => {
  const FRESH = 'a'.repeat(40)
  const STALE = 'b'.repeat(40)
  const rows = buildFlagshipFindings({ freshHead: FRESH, staleHead: STALE })

  it('produces eleven findings', () => {
    expect(rows).toHaveLength(11)
  })

  it('covers every severity including the unflavored row', () => {
    expect(new Set(rows.map((r) => r.severity))).toEqual(
      new Set(['critical', 'major', 'minor', null])
    )
  })

  it('covers every review layer', () => {
    const layers = new Set(rows.map((r) => r.layer))
    for (const l of ['correctness', 'security', 'tests', 'design-conformance']) {
      expect(layers).toContain(l)
    }
  })

  it('covers every review state', () => {
    expect(new Set(rows.map((r) => r.state))).toEqual(new Set(['pending', 'accepted', 'rejected']))
  })

  it('has exactly one row carrying all three status badges', () => {
    const triples = rows.filter(
      (r) => r.headSha === STALE && r.commentUrl !== null && r.pushedSha !== null
    )
    expect(triples).toHaveLength(1)
    expect(triples[0].layer).toBe('design-conformance')
  })

  it('leaves the unflavored row with no anchor and no badges', () => {
    const plain = rows.find((r) => r.severity === null)
    expect(plain.layer).toBeNull()
    expect(plain.diffPath).toBeNull()
    expect(plain.headSha).toBeNull()
    expect(plain.commentUrl).toBeNull()
    expect(plain.pushedSha).toBeNull()
  })

  it('includes two investigation-mode findings', () => {
    expect(rows.filter((r) => r.mode === 'investigation')).toHaveLength(2)
  })

  it('separates a suggested-change-only row from a comment-body-only row', () => {
    expect(rows.some((r) => r.suggestedChange !== null && r.commentBody === null)).toBe(true)
    expect(rows.some((r) => r.suggestedChange === null && r.commentBody !== null)).toBe(true)
  })

  it('carries exactly one long summary and one body', () => {
    expect(rows.filter((r) => r.summary.length > 120)).toHaveLength(1)
    expect(rows.filter((r) => r.body !== null)).toHaveLength(1)
  })
})

describe('buildThinFindings', () => {
  it('produces two review-mode findings', () => {
    const rows = buildThinFindings('HMT-2-green')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.mode === 'review')).toBe(true)
  })
})

describe('buildTrees', () => {
  const flagship = buildTrees('HMT-1-burst-token')

  it('keeps the two trees disjoint', () => {
    const e = Object.keys(flagship.evidence)
    const a = Object.keys(flagship.artifacts)
    expect(e.filter((p) => a.includes(p))).toEqual([])
  })

  it('gives the flagship a log big enough to chunk', () => {
    expect(flagship.evidence['app.log'].split('\n').length).toBeGreaterThan(2000)
  })

  it('ships an archive, an image and structured evidence', () => {
    const names = Object.keys(flagship.evidence)
    expect(names).toContain('logs.zip')
    expect(names).toContain('screenshot.png')
    expect(names).toContain('config.json')
    expect(names).toContain('timings.csv')
  })

  it('names review artifacts after the real checks on pull request 4', () => {
    const names = Object.keys(flagship.artifacts)
    expect(names).toContain('ci/verify-b.log')
    expect(names).toContain('ci/unit-tests.log')
    expect(names).toContain('ci/lint.log')
    expect(names).toContain('diff.patch')
    expect(names).toContain('review-report.md')
  })

  it('gives a thin case two artifacts and no evidence bulk', () => {
    const thin = buildTrees('HMT-2-green')
    expect(Object.keys(thin.artifacts)).toHaveLength(2)
  })
})
