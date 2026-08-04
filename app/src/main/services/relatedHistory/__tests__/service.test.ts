import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { upsertCaseSummary } from '../../distill/summaries'
import { RelatedHistoryService } from '../index'
import { DefectCorpusService } from '../../defectCorpus/service'
import type { HistoryProvider } from '../types'
import type { CorpusDefectHit, LocalCaseHit } from '../../../../shared/relatedHistory'

let home: string
let db: DatabaseSync

const noCorpus = (): DefectCorpusService =>
  new DefectCorpusService({ sources: () => ({}), token: () => undefined })

function fakeProvider(
  id: string,
  kind: 'local' | 'corpus',
  result: Awaited<ReturnType<HistoryProvider['search']>>
): HistoryProvider {
  return { id, name: id, kind, search: vi.fn(async () => result) }
}

const mkLocalHits = (n: number): LocalCaseHit[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'local' as const,
    id: `local:${i}`,
    caseSlug: String(i),
    jiraKey: null,
    provenance: [{ providerId: 'local', providerName: 'local', kind: 'local' as const }],
    title: 't',
    snippet: null,
    matchedOn: 'lexical' as const,
    rank: i + 1,
    fusedScore: 0,
    status: { label: 'solved', tone: 'resolved' as const },
    distilled: null
  }))

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-svc-'))
  db = openDb(path.join(home, 'argus.db'))
})

describe('RelatedHistoryService.search', () => {
  it('resolves the query from the case when only caseSlug is given', async () => {
    createCase(db, home, { slug: 'c1', title: 'Bearing jumps', jiraKey: 'NAV-7' })
    const svc = new RelatedHistoryService({ db, defectCorpus: noCorpus() })
    const r = await svc.search({ caseSlug: 'c1' })
    expect(r.query).toBe('Bearing jumps NAV-7')
  })

  it('uses the given text as a free-form query, even alongside a caseSlug', async () => {
    createCase(db, home, { slug: 'c1', title: 'Bearing jumps' })
    const svc = new RelatedHistoryService({ db, defectCorpus: noCorpus() })
    expect((await svc.search({ query: 'charge plan' })).query).toBe('charge plan')
    expect((await svc.search({ caseSlug: 'c1', query: 'charge plan' })).query).toBe('charge plan')
  })

  it('reports every provider in sources, healthy ones included', async () => {
    const svc = new RelatedHistoryService({
      db,
      defectCorpus: noCorpus(),
      providers: [
        fakeProvider('local', 'local', { ok: true, hits: [] }),
        fakeProvider('corpus:a', 'corpus', {
          ok: false,
          error: 'fetch failed',
          code: 'unreachable'
        })
      ]
    })
    const r = await svc.search({ query: 'x' })
    expect(r.sources).toEqual([
      { id: 'local', name: 'local', kind: 'local', ok: true },
      {
        id: 'corpus:a',
        name: 'corpus:a',
        kind: 'corpus',
        ok: false,
        error: 'fetch failed',
        code: 'unreachable'
      }
    ])
  })

  it('still returns healthy hits when another provider fails', async () => {
    const hit: LocalCaseHit = {
      kind: 'local',
      id: 'local:a',
      caseSlug: 'a',
      jiraKey: null,
      provenance: [{ providerId: 'local', providerName: 'local', kind: 'local' }],
      title: 't',
      snippet: null,
      matchedOn: 'lexical',
      rank: 1,
      fusedScore: 0,
      status: { label: 'solved', tone: 'resolved' },
      distilled: null
    }
    const svc = new RelatedHistoryService({
      db,
      defectCorpus: noCorpus(),
      providers: [
        fakeProvider('local', 'local', { ok: true, hits: [hit] }),
        fakeProvider('corpus:a', 'corpus', { ok: false, error: 'down' })
      ]
    })
    const r = await svc.search({ query: 'x' })
    expect(r.hits.map((h) => h.id)).toEqual(['local:a'])
  })

  it('never rejects when a provider throws', async () => {
    const thrower: HistoryProvider = {
      id: 'boom',
      name: 'boom',
      kind: 'corpus',
      search: vi.fn(async () => {
        throw new Error('kaboom')
      })
    }
    const svc = new RelatedHistoryService({ db, defectCorpus: noCorpus(), providers: [thrower] })
    const r = await svc.search({ query: 'x' })
    expect(r.hits).toEqual([])
    expect(r.sources[0]).toMatchObject({ ok: false, error: 'kaboom' })
  })

  it('reports no-providers when there is nothing at all to search', async () => {
    const svc = new RelatedHistoryService({ db, defectCorpus: noCorpus() })
    const r = await svc.search({ query: 'x' })
    expect(r.reason).toBe('no-providers')
    expect(r.sources).toEqual([])
  })

  it('includes the local provider once any summary exists', async () => {
    createCase(db, home, { slug: 'a', title: 'a' })
    upsertCaseSummary(
      db,
      home,
      'a',
      { signature: 'sig', symptoms: '', rootCause: '', fix: '', keywords: [] },
      'solved',
      'md'
    )
    const svc = new RelatedHistoryService({ db, defectCorpus: noCorpus() })
    const r = await svc.search({ query: 'sig' })
    expect(r.sources.map((s) => s.id)).toEqual(['local'])
    expect(r.reason).toBeUndefined()
  })

  it('propagates query-too-generic from the local provider', async () => {
    const svc = new RelatedHistoryService({
      db,
      defectCorpus: noCorpus(),
      providers: [
        fakeProvider('local', 'local', { ok: true, hits: [], reason: 'query-too-generic' })
      ]
    })
    expect((await svc.search({ query: 'x' })).reason).toBe('query-too-generic')
  })

  // Pins a fix over the plan's draft: the plan took the FIRST reason reported by
  // any provider, unconditionally. Per the design spec the UI renders NOTHING at
  // all when `reason` is set (query-too-generic / no-providers render nothing) —
  // so a benign per-provider reason (local's own guard tripping) must not blank
  // out real hits a DIFFERENT provider actually found. `reason` should describe
  // the aggregate result, not just whichever provider settled/iterated first.
  it('does not surface a benign reason when another provider found real hits', async () => {
    const corpusHit: CorpusDefectHit = {
      kind: 'corpus',
      id: 'corpus:a:DEF-1',
      sourceId: 'a',
      key: 'DEF-1',
      url: 'https://example.test/DEF-1',
      provenance: [{ providerId: 'corpus:a', providerName: 'corpus:a', kind: 'corpus' }],
      title: 't',
      snippet: null,
      matchedOn: 'lexical',
      rank: 1,
      fusedScore: 0,
      status: { label: 'open', tone: 'open' },
      distilled: null
    }
    const svc = new RelatedHistoryService({
      db,
      defectCorpus: noCorpus(),
      providers: [
        fakeProvider('local', 'local', { ok: true, hits: [], reason: 'query-too-generic' }),
        fakeProvider('corpus:a', 'corpus', { ok: true, hits: [corpusHit] })
      ]
    })
    const r = await svc.search({ query: 'x' })
    expect(r.reason).toBeUndefined()
    expect(r.hits.map((h) => h.id)).toEqual(['corpus:a:DEF-1'])
  })

  it('caps the fused list at the requested limit', async () => {
    const svc = new RelatedHistoryService({
      db,
      defectCorpus: noCorpus(),
      providers: [fakeProvider('local', 'local', { ok: true, hits: mkLocalHits(9) })]
    })
    expect((await svc.search({ query: 'x', limit: 4 })).hits).toHaveLength(4)
  })

  it('defaults the limit to 5 when none is requested', async () => {
    const svc = new RelatedHistoryService({
      db,
      defectCorpus: noCorpus(),
      providers: [fakeProvider('local', 'local', { ok: true, hits: mkLocalHits(9) })]
    })
    expect((await svc.search({ query: 'x' })).hits).toHaveLength(5)
  })

  it('passes the resolved limit through to each provider', async () => {
    const provider = fakeProvider('local', 'local', { ok: true, hits: [] })
    const svc = new RelatedHistoryService({ db, defectCorpus: noCorpus(), providers: [provider] })
    await svc.search({ query: 'x', limit: 4 })
    expect(provider.search).toHaveBeenCalledWith(expect.objectContaining({ text: 'x' }), 4)
  })

  it('returns an empty result for an input with neither caseSlug nor query', async () => {
    const svc = new RelatedHistoryService({ db, defectCorpus: noCorpus() })
    const r = await svc.search({})
    expect(r.query).toBe('')
    expect(r.hits).toEqual([])
  })

  // Important 1 (review pass 1): everything BEFORE the provider fan-out —
  // resolveQuery -> buildRelatedQuery -> getCase/getCaseSummary/recentFindingSummaries,
  // and providers() -> summaryPopulation — is a raw, synchronous db.prepare()
  // call. A corrupt index or a closed handle throws synchronously inside this
  // async method, which becomes a REJECTED promise unless the whole body is
  // guarded. This must resolve, and the failure must stay visible (a synthetic
  // failed source), not collapse into a silent empty result.
  it('resolves with a visible failed source when the pre-fan-out path throws', async () => {
    const svc = new RelatedHistoryService({ db, defectCorpus: noCorpus() })
    db.close()
    const r = await svc.search({ caseSlug: 'nope' })
    expect(r.hits).toEqual([])
    expect(r.sources).toHaveLength(1)
    expect(r.sources[0]).toMatchObject({ ok: false })
    expect(r.sources[0].error).toBeTruthy()
  })

  // Important 2 (review pass 1): reason must not paper over a failed source.
  // If it did, a dead corpus would go invisible again whenever the local
  // provider ALSO trips its own generic-query guard — the design has the UI
  // render nothing at all when `reason` is set, which would hide the "corpus
  // unavailable" chrome along with it.
  it('does not surface a reason when a source failed, even with no hits', async () => {
    const svc = new RelatedHistoryService({
      db,
      defectCorpus: noCorpus(),
      providers: [
        fakeProvider('local', 'local', { ok: true, hits: [], reason: 'query-too-generic' }),
        fakeProvider('corpus:a', 'corpus', { ok: false, error: 'down' })
      ]
    })
    const r = await svc.search({ query: 'x' })
    expect(r.reason).toBeUndefined()
    expect(r.sources).toContainEqual({
      id: 'corpus:a',
      name: 'corpus:a',
      kind: 'corpus',
      ok: false,
      error: 'down'
    })
  })
})
