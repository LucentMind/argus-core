import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { upsertCaseSummary } from '../../distill/summaries'
import { RelatedHistoryService } from '../index'
import type { DefectCorpusService } from '../../defectCorpus/service'

function db(): { db: DatabaseSync; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sources-'))
  return { db: openDb(path.join(home, 'argus.db')), home }
}

function seedSummary(d: DatabaseSync, home: string): void {
  createCase(d, home, { slug: 'closed', title: 'closed' })
  upsertCaseSummary(
    d,
    home,
    'closed',
    { signature: 'ecu reset drifts', symptoms: '', rootCause: '', fix: '', keywords: [] },
    'solved',
    'md'
  )
}

function corpus(over: Partial<DefectCorpusService>): DefectCorpusService {
  return {
    enabledSources: () => [{ id: 'src1', name: 'Hindsight', baseUrl: 'https://c1' }],
    ...over
  } as unknown as DefectCorpusService
}

describe('RelatedHistoryService.sources', () => {
  it('reports the local provider and a healthy corpus with its capabilities', async () => {
    const { db: d, home } = db()
    seedSummary(d, home)
    const svc = new RelatedHistoryService({
      db: d,
      defectCorpus: corpus({
        test: async () => ({
          ok: true,
          info: {
            name: 'ref',
            contract: '1.0',
            projects: ['KAN', 'NAV'],
            ticketCount: 3,
            lastSyncAt: null,
            capabilities: { semantic: true, admin: false, enrichment: { distilled: 1, total: 3 } }
          }
        })
      } as unknown as Partial<DefectCorpusService>)
    })
    expect(await svc.sources()).toEqual([
      { id: 'local', name: 'Your cases', kind: 'local', ok: true, semantic: false, projects: [] },
      {
        id: 'corpus:src1',
        name: 'Hindsight',
        kind: 'corpus',
        ok: true,
        semantic: true,
        projects: ['KAN', 'NAV']
      }
    ])
  })

  it('reports an unreachable corpus as a failed entry, never rejecting', async () => {
    const { db: d, home } = db()
    seedSummary(d, home)
    const svc = new RelatedHistoryService({
      db: d,
      defectCorpus: corpus({
        test: async () => ({ ok: false, error: 'fetch failed' })
      } as unknown as Partial<DefectCorpusService>)
    })
    const out = await svc.sources()
    expect(out[1]).toEqual({
      id: 'corpus:src1',
      name: 'Hindsight',
      kind: 'corpus',
      ok: false,
      error: 'fetch failed',
      semantic: false,
      projects: []
    })
  })

  it('omits the local entry when nothing is distilled, matching the search fan-out', async () => {
    const { db: d } = db()
    const svc = new RelatedHistoryService({
      db: d,
      defectCorpus: corpus({ enabledSources: () => [] } as unknown as Partial<DefectCorpusService>)
    })
    expect(await svc.sources()).toEqual([])
  })

  it('never rejects when the settings read itself throws', async () => {
    const { db: d } = db()
    const svc = new RelatedHistoryService({
      db: d,
      defectCorpus: corpus({
        enabledSources: () => {
          throw new Error('settings unreadable')
        }
      } as unknown as Partial<DefectCorpusService>)
    })
    const out = await svc.sources()
    expect(out).toEqual([
      {
        id: 'related-history',
        name: 'Related history',
        kind: 'service',
        ok: false,
        error: 'settings unreadable',
        semantic: false,
        projects: []
      }
    ])
  })
})
