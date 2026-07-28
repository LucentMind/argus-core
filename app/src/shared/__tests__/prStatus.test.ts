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
  url: null,
  jobId: null,
  ...over
})

describe('actionsJobId', () => {
  it('extracts the job id from an Actions details url', () => {
    expect(actionsJobId('https://github.com/acme/widget/actions/runs/123/job/456')).toBe(456)
  })

  it('tolerates a query string and a trailing slash', () => {
    expect(actionsJobId('https://github.com/acme/widget/actions/runs/123/job/456?check_suite=9')).toBe(456)
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
    expect(bucketOfCheckRun('COMPLETED', 'CANCELLED')).toBe('fail')
    expect(bucketOfCheckRun('COMPLETED', 'ACTION_REQUIRED')).toBe('fail')
    expect(bucketOfCheckRun('COMPLETED', 'STARTUP_FAILURE')).toBe('fail')
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

  it('is passing when every check passed or was skipped', () => {
    expect(rollupOf([check({ bucket: 'pass' }), check({ bucket: 'skipped' })])).toBe('passing')
  })

  it('is running while any check is pending and none failed', () => {
    expect(rollupOf([check({ bucket: 'pass' }), check({ bucket: 'pending' })])).toBe('running')
  })

  it('prefers failing over running — a failure is the actionable state', () => {
    expect(rollupOf([check({ bucket: 'fail' }), check({ bucket: 'pending' })])).toBe('failing')
  })
})
