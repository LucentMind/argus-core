import { describe, expect, it } from 'vitest'
import {
  actionsJobId as realJobId,
  bucketOfCheckRun as real,
  bucketOfStatusContext as realStatusContext,
  rollupOf as realRollup
} from '../../../src/shared/prStatus'
// @ts-expect-error — plain ESM fixture module, no type declarations
import {
  actionsJobId as copyJobId,
  bucketOfCheckRun as copy,
  bucketOfStatusContext as copyStatusContext,
  rollupOf as copyRollup
} from '../prs.mjs'

/**
 * scripts/seed/prs.mjs re-implements two pure functions from src/shared/prStatus.ts
 * because the seed script runs unbuilt and cannot import TypeScript. That copy is
 * allowed to exist ONLY while it agrees with the original — a fixture that reports
 * CI state differently from the app is worse than no fixture. This test is the alarm.
 */
describe('seed prs.mjs parity with src/shared/prStatus.ts', () => {
  const STATUSES = ['COMPLETED', 'IN_PROGRESS', 'QUEUED', 'PENDING', null]
  const CONCLUSIONS = [
    'SUCCESS',
    'NEUTRAL',
    'FAILURE',
    'CANCELLED',
    'STALE',
    'SKIPPED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'SOMETHING_NEW',
    null
  ]

  it('agrees on every status/conclusion pair', () => {
    for (const s of STATUSES) {
      for (const c of CONCLUSIONS) {
        expect(`${s}/${c}: ${copy(s, c)}`).toBe(`${s}/${c}: ${real(s, c)}`)
      }
    }
  })

  it('agrees on every rollup-relevant check-list shape', () => {
    const BUCKETS = ['pass', 'fail', 'cancelled', 'pending', 'skipped'] as const
    const shapes: Array<Array<{ bucket: string; required: boolean }>> = [[]]
    for (const b of BUCKETS) {
      for (const required of [true, false]) {
        shapes.push([{ bucket: b, required }])
        for (const b2 of BUCKETS) {
          shapes.push([
            { bucket: b, required },
            { bucket: b2, required: !required }
          ])
        }
      }
    }
    for (const shape of shapes) {
      const checks = shape.map((c, i) => ({ ...c, name: `c${i}`, url: null, jobId: null }))
      const label = JSON.stringify(shape)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyChecks = checks as any
      expect(`${label}: ${copyRollup(anyChecks)}`).toBe(`${label}: ${realRollup(anyChecks)}`)
    }
  })

  it('agrees on every status-context state', () => {
    const STATES = ['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED', 'SOMETHING_NEW', null]
    for (const s of STATES) {
      expect(`${s}: ${copyStatusContext(s)}`).toBe(`${s}: ${realStatusContext(s)}`)
    }
  })

  it('agrees on the Actions job id extracted from a check url', () => {
    const URLS = [
      // A real Actions job url.
      'https://github.com/JiaweiHan88/HiveMindTest/actions/runs/30500000001/job/90600000001',
      // An Actions *run* url with no job segment.
      'https://github.com/JiaweiHan88/HiveMindTest/actions/runs/30500000001',
      // A third-party url.
      'https://app.netlify.com/sites/demo/deploys/abc123',
      // A github.com url with no job segment at all (e.g. CodeQL's own-issued context url).
      'https://github.com/JiaweiHan88/HiveMindTest/runs/123',
      // Trailing query and fragment after the job id.
      'https://github.com/JiaweiHan88/HiveMindTest/actions/runs/30500000001/job/90600000001?pr=999',
      'https://github.com/JiaweiHan88/HiveMindTest/actions/runs/30500000001/job/90600000001#step:2:10',
      null
    ]
    for (const url of URLS) {
      expect(`${url}: ${copyJobId(url)}`).toBe(`${url}: ${realJobId(url)}`)
    }
  })
})
