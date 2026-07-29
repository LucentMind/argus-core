import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { addBinding, removeBinding, getBinding } from '../prBindings'
import { readPrStatuses, writePrStatus } from '../prStatusCache'
import { refreshPrStatuses } from '../prStatusService'
import type { Runner } from '../github'
import type { PrStatus } from '../../../shared/prStatus'

let db: DatabaseSync
let home: string

const NOW = '2026-07-27T12:00:00.000Z'
const now = (): string => NOW

function bind(slug: string, repo: string, number: number): void {
  addBinding(db, slug, {
    repoPath: null,
    owner: 'acme',
    repo,
    number,
    url: `https://github.com/acme/${repo}/pull/${number}`,
    source: 'manual'
  })
}

function prNode(number: number, conclusion: string, isRequired = false): unknown {
  return {
    pullRequest: {
      number,
      url: `https://github.com/acme/widget/pull/${number}`,
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
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
                      conclusion,
                      isRequired,
                      detailsUrl: 'https://github.com/acme/widget/actions/runs/1/job/9'
                    }
                  ]
                }
              }
            }
          }
        ]
      }
    }
  }
}

const cached = (over: Partial<PrStatus> = {}): PrStatus => ({
  owner: 'acme',
  repo: 'widget',
  number: 42,
  url: 'https://github.com/acme/widget/pull/42',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  rollup: 'passing',
  checks: [],
  fetchedAt: NOW,
  error: null,
  ...over
})

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prsvc-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
  createCase(db, home, { slug: 'c2', title: 'Case 2' })
})

describe('refreshPrStatuses', () => {
  it('fetches every bound case in ONE gh call and caches each result', async () => {
    bind('c1', 'widget', 42)
    bind('c2', 'widget', 43)
    let calls = 0
    const gh: Runner = async () => {
      calls++
      return JSON.stringify({
        data: { t0: prNode(42, 'SUCCESS'), t1: prNode(43, 'FAILURE', true) }
      })
    }
    const out = await refreshPrStatuses({ db, gh, now }, ['c1', 'c2'])
    expect(calls).toBe(1)
    expect(out['c1'].rollup).toBe('passing')
    expect(out['c2'].rollup).toBe('failing')
    expect(readPrStatuses(db, ['c1', 'c2'])['c2'].rollup).toBe('failing')
  })

  it('skips unbound cases entirely and does not cache them', async () => {
    bind('c1', 'widget', 42)
    const gh: Runner = async () => JSON.stringify({ data: { t0: prNode(42, 'SUCCESS') } })
    const out = await refreshPrStatuses({ db, gh, now }, ['c1', 'c2'])
    expect(Object.keys(out)).toEqual(['c1'])
    expect(Object.keys(readPrStatuses(db, ['c1', 'c2']))).toEqual(['c1'])
  })

  it('makes no gh call when no case in the list is bound', async () => {
    const gh: Runner = async () => {
      throw new Error('gh must not be called')
    }
    expect(await refreshPrStatuses({ db, gh, now }, ['c1', 'c2'])).toEqual({})
  })

  it('overwrites a stale green with unavailable rather than leaving it', async () => {
    bind('c1', 'widget', 42)
    writePrStatus(db, 'c1', cached({ rollup: 'passing' }))
    const gh: Runner = async () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 404: Not Found' })
    }
    const out = await refreshPrStatuses({ db, gh, now }, ['c1'])
    expect(out['c1'].rollup).toBe('unavailable')
    expect(readPrStatuses(db, ['c1'])['c1'].rollup).toBe('unavailable')
  })
})

describe('binding changes invalidate the cache', () => {
  it('clears the cached status when a different PR is bound', () => {
    bind('c1', 'widget', 42)
    writePrStatus(db, 'c1', cached())
    bind('c1', 'widget', 99)
    expect(readPrStatuses(db, ['c1'])).toEqual({})
  })

  it('clears the cached status when the binding is removed', () => {
    bind('c1', 'widget', 42)
    writePrStatus(db, 'c1', cached())
    removeBinding(db, 'c1', getBinding(db, 'c1')!.id)
    expect(readPrStatuses(db, ['c1'])).toEqual({})
  })
})
