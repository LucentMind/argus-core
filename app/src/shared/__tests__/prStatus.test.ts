import { describe, it, expect } from 'vitest'
import {
  actionsJobId,
  bucketOfCheckRun,
  bucketOfStatusContext,
  rollupOf,
  type PrCheck
} from '../prStatus'

const check = (over: Partial<PrCheck>): PrCheck => ({
  name: 'c',
  bucket: 'pass',
  required: false,
  url: null,
  jobId: null,
  ...over
})

describe('actionsJobId', () => {
  it('extracts the job id from an Actions details url', () => {
    expect(actionsJobId('https://github.com/acme/widget/actions/runs/123/job/456')).toBe(456)
  })

  it('tolerates a query string and a trailing slash', () => {
    expect(
      actionsJobId('https://github.com/acme/widget/actions/runs/123/job/456?check_suite=9')
    ).toBe(456)
    expect(actionsJobId('https://github.com/acme/widget/actions/runs/123/job/456/')).toBe(456)
  })

  it('returns null for a non-Actions check url', () => {
    expect(actionsJobId('https://circleci.com/gh/acme/widget/789')).toBeNull()
    expect(actionsJobId('https://github.com/acme/widget/actions/runs/123')).toBeNull()
    expect(actionsJobId(null)).toBeNull()
  })
})

describe('bucketOfCheckRun', () => {
  it('buckets a completed run by its conclusion', () => {
    expect(bucketOfCheckRun('COMPLETED', 'SUCCESS')).toBe('pass')
    expect(bucketOfCheckRun('COMPLETED', 'NEUTRAL')).toBe('pass')
    expect(bucketOfCheckRun('COMPLETED', 'SKIPPED')).toBe('skipped')
    expect(bucketOfCheckRun('COMPLETED', 'FAILURE')).toBe('fail')
    expect(bucketOfCheckRun('COMPLETED', 'TIMED_OUT')).toBe('fail')
    expect(bucketOfCheckRun('COMPLETED', 'ACTION_REQUIRED')).toBe('fail')
    expect(bucketOfCheckRun('COMPLETED', 'STARTUP_FAILURE')).toBe('fail')
  })

  // GitHub discarded these runs — a newer push, a concurrency group, a sibling job failing.
  // Neither is a verdict on the code, and neither log holds a cause worth reading.
  it('separates the runs GitHub discarded from the runs that failed', () => {
    expect(bucketOfCheckRun('COMPLETED', 'CANCELLED')).toBe('cancelled')
    expect(bucketOfCheckRun('COMPLETED', 'STALE')).toBe('cancelled')
  })

  it('treats anything not yet completed as pending', () => {
    expect(bucketOfCheckRun('QUEUED', null)).toBe('pending')
    expect(bucketOfCheckRun('IN_PROGRESS', null)).toBe('pending')
  })

  it('treats a completed run with an unrecognized conclusion as failing, not passing', () => {
    expect(bucketOfCheckRun('COMPLETED', 'SOMETHING_NEW')).toBe('fail')
    expect(bucketOfCheckRun('COMPLETED', null)).toBe('fail')
  })
})

describe('bucketOfStatusContext', () => {
  it('maps commit-status states', () => {
    expect(bucketOfStatusContext('SUCCESS')).toBe('pass')
    expect(bucketOfStatusContext('FAILURE')).toBe('fail')
    expect(bucketOfStatusContext('ERROR')).toBe('fail')
    expect(bucketOfStatusContext('PENDING')).toBe('pending')
    expect(bucketOfStatusContext('EXPECTED')).toBe('pending')
    expect(bucketOfStatusContext(null)).toBe('pending')
  })
})

describe('rollupOf', () => {
  it('is none with no checks', () => {
    expect(rollupOf([])).toBe('none')
  })

  it('is passing when every check passed, was skipped, or was an optional cancellation', () => {
    expect(
      rollupOf([
        check({ bucket: 'pass' }),
        check({ bucket: 'skipped' }),
        check({ bucket: 'cancelled' })
      ])
    ).toBe('passing')
  })

  it('is failing when a required check failed', () => {
    expect(rollupOf([check({ bucket: 'fail', required: true }), check({ bucket: 'pass' })])).toBe(
      'failing'
    )
  })

  it('is unstable when the only failure does not block the merge', () => {
    expect(rollupOf([check({ bucket: 'fail' }), check({ bucket: 'pass', required: true })])).toBe(
      'unstable'
    )
  })

  it('is unstable when a required check was cancelled — it cannot merge until it re-runs', () => {
    expect(rollupOf([check({ bucket: 'cancelled', required: true })])).toBe('unstable')
  })

  it('is running while any check is pending and nothing has failed', () => {
    expect(rollupOf([check({ bucket: 'pass' }), check({ bucket: 'pending' })])).toBe('running')
  })

  it('prefers a required failure over everything else — it is the actionable state', () => {
    expect(
      rollupOf([
        check({ bucket: 'fail', required: true }),
        check({ bucket: 'fail' }),
        check({ bucket: 'pending' })
      ])
    ).toBe('failing')
  })

  // A repository with no branch protection has no required checks, so nothing can be red.
  // Intended: with nothing gating the merge, a failure is information rather than a verdict.
  it('never reports failing on a repository with no required checks', () => {
    expect(rollupOf([check({ bucket: 'fail' }), check({ bucket: 'fail' })])).toBe('unstable')
  })
})
