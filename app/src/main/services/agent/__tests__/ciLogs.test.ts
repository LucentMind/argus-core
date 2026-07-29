import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { addBinding } from '../../prBindings'
import { listEvidence } from '../../ingest'
import { createDetection } from '../../packs/detection'
import { fetchCheckLogs, CI_LOG_MAX_BYTES } from '../ciLogs'
import type { Runner } from '../../github'

let db: DatabaseSync
let home: string

function statusPayload(checks: unknown[]): string {
  return JSON.stringify({
    data: {
      t0: {
        pullRequest: {
          number: 42,
          url: 'https://github.com/acme/widget/pull/42',
          state: 'OPEN',
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: null,
          commits: {
            nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }]
          }
        }
      }
    }
  })
}

const BUILD = {
  __typename: 'CheckRun',
  name: 'build',
  status: 'COMPLETED',
  conclusion: 'FAILURE',
  detailsUrl: 'https://github.com/acme/widget/actions/runs/1/job/99'
}
const CIRCLE = {
  __typename: 'StatusContext',
  context: 'ci/circleci',
  state: 'FAILURE',
  targetUrl: 'https://circleci.com/x'
}

const deps = (gh: Runner): Parameters<typeof fetchCheckLogs>[0] => ({
  db,
  argusHome: home,
  detection: createDetection(),
  gh
})

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-cilogs-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
  addBinding(db, 'c1', {
    repoPath: null,
    owner: 'acme',
    repo: 'widget',
    number: 42,
    url: 'https://github.com/acme/widget/pull/42',
    source: 'manual'
  })
})

describe('fetchCheckLogs', () => {
  it('resolves the check by name and ingests its log as ci evidence', async () => {
    const seen: string[][] = []
    const gh: Runner = async (_cmd, args) => {
      seen.push(args)
      if (args[1] === 'graphql') return statusPayload([BUILD])
      return 'FAIL src/guard.test.ts\n  expected true, got false\n'
    }
    const out = await fetchCheckLogs(deps(gh), 'c1', 'build')
    expect(out.text).toContain('expected true, got false')

    // review-scoped: a CI job log is review material by construction (Task 7), so it lives
    // under artifacts/ and the default (investigation-scoped) listEvidence no longer sees it.
    const ev = listEvidence(db, 'c1', 'all').find((e) => e.id === out.evidenceId)!
    expect(ev.origin).toBe('ci')
    expect(ev.relPath).toMatch(/build/)
    expect(ev.meta.checkName).toBe('build')
    expect(seen[1]).toEqual(['api', 'repos/acme/widget/actions/jobs/99/logs'])
    // The stored path is what the tool feedback tells the agent to cite ([artifacts/...:line] —
    // the renderer's citation grammar). An evidence_id-based citation renders as dead text,
    // which is exactly what the 2026-07-29 acceptance run produced before this was returned.
    expect(out.relPath).toBe(ev.relPath)
    expect(out.relPath).toMatch(/^artifacts\//)
  })

  it('matches the check name case-insensitively', async () => {
    const gh: Runner = async (_cmd, args) =>
      args[1] === 'graphql' ? statusPayload([BUILD]) : 'log'
    await expect(fetchCheckLogs(deps(gh), 'c1', 'BUILD')).resolves.toBeTruthy()
  })

  it('lists the available names when the check is unknown', async () => {
    const gh: Runner = async (_cmd, args) =>
      args[1] === 'graphql' ? statusPayload([BUILD, CIRCLE]) : 'log'
    await expect(fetchCheckLogs(deps(gh), 'c1', 'nope')).rejects.toThrow(
      /no check named "nope".*build.*ci\/circleci/is
    )
  })

  it('refuses a non-Actions check instead of fetching a url it cannot read', async () => {
    const gh: Runner = async (_cmd, args) => {
      if (args[1] === 'graphql') return statusPayload([CIRCLE])
      throw new Error('must not fetch a log for a third-party check')
    }
    await expect(fetchCheckLogs(deps(gh), 'c1', 'ci/circleci')).rejects.toThrow(
      /not a github actions job/i
    )
  })

  it('refuses when no PR is bound', async () => {
    createCase(db, home, { slug: 'c2', title: 'Case 2' })
    const gh: Runner = async () => {
      throw new Error('gh must not be called')
    }
    await expect(fetchCheckLogs(deps(gh), 'c2', 'build')).rejects.toThrow(/no pull request/i)
  })

  it('truncates a huge log and says so, rather than ingesting it whole', async () => {
    const huge = 'x'.repeat(CI_LOG_MAX_BYTES + 5000)
    const gh: Runner = async (_cmd, args) => (args[1] === 'graphql' ? statusPayload([BUILD]) : huge)
    const out = await fetchCheckLogs(deps(gh), 'c1', 'build')
    expect(out.text.length).toBeLessThan(huge.length)
    expect(out.text).toMatch(/truncated/i)
    // the TAIL is kept: a build log's failure is at the end
    expect(out.text.endsWith('x')).toBe(true)
  })

  it('files the job log as a review artifact', async () => {
    const gh: Runner = async (_cmd, args) =>
      args[1] === 'graphql' ? statusPayload([BUILD]) : 'log body'
    const out = await fetchCheckLogs(deps(gh), 'c1', 'build')
    expect(out.relPath).toMatch(/^artifacts\//)
    expect(listEvidence(db, 'c1', 'review')).toHaveLength(1)
    expect(listEvidence(db, 'c1')).toHaveLength(0)
  })

  it('prefers the FAILING run when several checks share a name', async () => {
    // Real PRs repeat check names (Task 1 capture: one PR listed "Semantic Pull Request" twice,
    // another had 46 contexts under 20 names). Resolving by name must not pick an arbitrary run
    // — "analyze the failing build" has to reach the failing build's job.
    const PASSED_BUILD = {
      __typename: 'CheckRun',
      name: 'build',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      detailsUrl: 'https://github.com/acme/widget/actions/runs/2/job/11'
    }
    const seen: string[][] = []
    const gh: Runner = async (_cmd, args) => {
      seen.push(args)
      return args[1] === 'graphql' ? statusPayload([PASSED_BUILD, BUILD]) : 'log'
    }
    await fetchCheckLogs(deps(gh), 'c1', 'build')
    expect(seen[1]).toEqual(['api', 'repos/acme/widget/actions/jobs/99/logs'])
  })

  it('prefers the run that failed over a same-named run GitHub cancelled', async () => {
    const CANCELLED = {
      __typename: 'CheckRun',
      name: 'build',
      status: 'COMPLETED',
      conclusion: 'CANCELLED',
      detailsUrl: 'https://github.com/acme/widget/actions/runs/1/job/11'
    }
    const seen: string[][] = []
    const gh: Runner = async (_cmd, args) => {
      seen.push(args)
      if (args[1] === 'graphql') return statusPayload([CANCELLED, BUILD])
      return 'log'
    }
    await fetchCheckLogs(deps(gh), 'c1', 'build')
    expect(seen[1]).toEqual(['api', 'repos/acme/widget/actions/jobs/99/logs'])
  })
})
