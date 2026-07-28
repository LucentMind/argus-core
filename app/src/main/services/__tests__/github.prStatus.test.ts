import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildPrStatusQuery, fetchPrStatuses, prTargetKey, type Runner } from '../github'

const NOW = '2026-07-27T12:00:00.000Z'
const T0 = { owner: 'acme', repo: 'widget', number: 42 }

function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      t0: {
        pullRequest: {
          number: 42,
          url: 'https://github.com/acme/widget/pull/42',
          state: 'OPEN',
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: 'REVIEW_REQUIRED',
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          name: 'build',
                          status: 'COMPLETED',
                          conclusion: 'FAILURE',
                          detailsUrl: 'https://github.com/acme/widget/actions/runs/1/job/99'
                        },
                        {
                          __typename: 'StatusContext',
                          context: 'ci/circleci',
                          state: 'SUCCESS',
                          targetUrl: 'https://circleci.com/gh/acme/widget/7'
                        }
                      ]
                    }
                  }
                }
              }
            ]
          },
          ...over
        }
      }
    }
  })
}

describe('buildPrStatusQuery', () => {
  it('aliases one repository block per target', () => {
    const q = buildPrStatusQuery([T0, { owner: 'other', repo: 'thing', number: 7 }])
    expect(q).toContain('t0: repository(owner: "acme", name: "widget")')
    expect(q).toContain('pullRequest(number: 42)')
    expect(q).toContain('t1: repository(owner: "other", name: "thing")')
    expect(q).toContain('pullRequest(number: 7)')
  })

  it('refuses an owner or repo that is not a bare name', () => {
    expect(() => buildPrStatusQuery([{ owner: 'a"c', repo: 'widget', number: 1 }])).toThrow(
      /invalid repository/i
    )
    expect(() => buildPrStatusQuery([{ owner: 'acme', repo: 'w) { x }', number: 1 }])).toThrow(
      /invalid repository/i
    )
  })

  it('refuses a non-integer pr number', () => {
    expect(() => buildPrStatusQuery([{ owner: 'acme', repo: 'widget', number: 1.5 }])).toThrow(
      /invalid pull request number/i
    )
  })
})

describe('fetchPrStatuses', () => {
  it('returns an empty map without calling gh when there are no targets', async () => {
    const run: Runner = async () => {
      throw new Error('gh must not be called')
    }
    expect((await fetchPrStatuses(run, [], NOW)).size).toBe(0)
  })

  it('maps checks, derives the rollup and keys by owner/repo#number', async () => {
    const run: Runner = async () => payload()
    const map = await fetchPrStatuses(run, [T0], NOW)
    const s = map.get(prTargetKey(T0))!
    expect(s.rollup).toBe('failing')
    expect(s.state).toBe('OPEN')
    expect(s.reviewDecision).toBe('REVIEW_REQUIRED')
    expect(s.fetchedAt).toBe(NOW)
    expect(s.error).toBeNull()
    expect(s.checks).toEqual([
      {
        name: 'build',
        bucket: 'fail',
        url: 'https://github.com/acme/widget/actions/runs/1/job/99',
        jobId: 99
      },
      {
        name: 'ci/circleci',
        bucket: 'pass',
        url: 'https://circleci.com/gh/acme/widget/7',
        jobId: null
      }
    ])
  })

  it('reports no checks as a none rollup, not as passing', async () => {
    const run: Runner = async () =>
      JSON.stringify({
        data: {
          t0: {
            pullRequest: {
              number: 42,
              url: 'https://github.com/acme/widget/pull/42',
              state: 'OPEN',
              isDraft: true,
              mergeable: 'UNKNOWN',
              reviewDecision: null,
              commits: { nodes: [{ commit: { statusCheckRollup: null } }] }
            }
          }
        }
      })
    const s = (await fetchPrStatuses(run, [T0], NOW)).get(prTargetKey(T0))!
    expect(s.rollup).toBe('none')
    expect(s.checks).toEqual([])
    expect(s.isDraft).toBe(true)
  })

  it('keeps good targets and marks only the failing one unavailable', async () => {
    const T1 = { owner: 'acme', repo: 'gone', number: 1 }
    // gh exits non-zero on GraphQL errors but still prints the body; the runner rejection
    // carries it on `stdout` (see fixtures/README.md, captured in Task 1).
    const run: Runner = async () => {
      throw Object.assign(new Error('Command failed'), {
        stdout: JSON.stringify({
          data: { ...JSON.parse(payload()).data, t1: null },
          errors: [{ path: ['t1'], message: 'Could not resolve to a Repository with the name.' }]
        }),
        stderr: 'gh: Could not resolve to a Repository with the name.'
      })
    }
    const map = await fetchPrStatuses(run, [T0, T1], NOW)
    expect(map.get(prTargetKey(T0))!.rollup).toBe('failing')
    const bad = map.get(prTargetKey(T1))!
    expect(bad.rollup).toBe('unavailable')
    expect(bad.error).toMatch(/could not resolve/i)
    expect(bad.checks).toEqual([])
  })

  it('marks every target unavailable when gh fails with no parsable body', async () => {
    const run: Runner = async () => {
      throw Object.assign(new Error('spawn gh'), { code: 'ENOENT' })
    }
    const map = await fetchPrStatuses(run, [T0], NOW)
    const s = map.get(prTargetKey(T0))!
    expect(s.rollup).toBe('unavailable')
    expect(s.error).toBe('GitHub CLI (gh) is not installed')
  })

  it('marks a target unavailable when its alias came back null with no matching error path', async () => {
    const run: Runner = async () => JSON.stringify({ data: { t0: null } })
    const s = (await fetchPrStatuses(run, [T0], NOW)).get(prTargetKey(T0))!
    expect(s.rollup).toBe('unavailable')
    expect(s.error).toMatch(/no data/i)
  })

  it('parses the real capture from Task 1 without throwing', async () => {
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'prStatus.graphql.json'), 'utf8')
    const run: Runner = async () => raw
    const map = await fetchPrStatuses(run, [T0], NOW)
    const s = map.get(prTargetKey(T0))!
    // The capture is from a real PR, so its values are unknown — but the SHAPE must survive:
    // a status is produced, it is not unavailable, and every check got a bucket and a name.
    expect(s.rollup).not.toBe('unavailable')
    for (const c of s.checks) {
      expect(c.name.length).toBeGreaterThan(0)
      expect(['pass', 'fail', 'pending', 'skipped']).toContain(c.bucket)
    }
  })

  it('keeps same-named checks as separate rows — real PRs repeat check names', async () => {
    // Observed in the Task 1 capture: vitejs/vite#23097 lists "Semantic Pull Request" twice, and
    // cli/cli#13998 had 46 contexts under 20 distinct names. Collapsing by name would hide runs.
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'prStatus.graphql.json'), 'utf8')
    const nodes = (
      JSON.parse(raw) as {
        data: {
          t0: {
            pullRequest: {
              commits: {
                nodes: { commit: { statusCheckRollup: { contexts: { nodes: unknown[] } } } }[]
              }
            }
          }
        }
      }
    ).data.t0.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes
    const run: Runner = async () => raw
    const s = (await fetchPrStatuses(run, [T0], NOW)).get(prTargetKey(T0))!
    expect(s.checks).toHaveLength(nodes.length)
    expect(new Set(s.checks.map((c) => c.name)).size).toBeLessThan(s.checks.length)
  })
})
