import { describe, it, expect } from 'vitest'
import { fuse, rrfScore, RRF_K } from '../fuse'
import type { ProviderRanking } from '../types'
import type { CorpusDefectHit, LocalCaseHit } from '../../../../shared/relatedHistory'

function local(slug: string, rank: number, jiraKey: string | null = null): LocalCaseHit {
  return {
    kind: 'local',
    id: `local:${slug}`,
    caseSlug: slug,
    jiraKey,
    provenance: [{ providerId: 'local', providerName: 'Your cases', kind: 'local' }],
    title: `sig ${slug}`,
    snippet: null,
    matchedOn: 'lexical',
    rank,
    fusedScore: 0,
    status: { label: 'solved', tone: 'resolved' },
    distilled: null
  }
}

function corpus(key: string, rank: number, sourceId = 'src1'): CorpusDefectHit {
  return {
    kind: 'corpus',
    id: `corpus:${sourceId}:${key}`,
    sourceId,
    key,
    url: `https://corpus.example/browse/${key}`,
    provenance: [{ providerId: `corpus:${sourceId}`, providerName: 'Hindsight', kind: 'corpus' }],
    title: `summary ${key}`,
    snippet: null,
    matchedOn: 'semantic',
    rank,
    fusedScore: 0,
    status: { label: 'Done/Fixed', tone: 'resolved' },
    distilled: null
  }
}

const localRanking = (hits: LocalCaseHit[]): ProviderRanking => ({
  providerId: 'local',
  providerName: 'Your cases',
  kind: 'local',
  order: 0,
  hits
})

const corpusRanking = (hits: CorpusDefectHit[], order = 1, id = 'src1'): ProviderRanking => ({
  providerId: `corpus:${id}`,
  providerName: 'Hindsight',
  kind: 'corpus',
  order,
  hits
})

describe('rrfScore', () => {
  it('is 1/(k+rank) and strictly decreasing in rank', () => {
    expect(rrfScore(1)).toBeCloseTo(1 / (RRF_K + 1))
    expect(rrfScore(1)).toBeGreaterThan(rrfScore(2))
  })
})

describe('fuse', () => {
  it('interleaves by rank across providers', () => {
    const out = fuse([
      localRanking([local('a', 1), local('b', 2)]),
      corpusRanking([corpus('K-1', 1), corpus('K-2', 2)])
    ])
    expect(out.map((h) => h.id)).toEqual([
      'local:a',
      'corpus:src1:K-1',
      'local:b',
      'corpus:src1:K-2'
    ])
  })

  it('breaks a score tie by local-before-corpus', () => {
    const out = fuse([localRanking([local('a', 1)]), corpusRanking([corpus('K-1', 1)])])
    expect(out[0].kind).toBe('local')
  })

  it('breaks a same-kind tie by provider order, then by id', () => {
    const out = fuse([
      corpusRanking([corpus('K-9', 1, 'src2')], 2, 'src2'),
      corpusRanking([corpus('K-1', 1, 'src1')], 1, 'src1')
    ])
    expect(out.map((h) => h.id)).toEqual(['corpus:src1:K-1', 'corpus:src2:K-9'])

    const sameOrder = fuse([
      corpusRanking([corpus('K-9', 1, 'src1'), corpus('K-1', 1, 'src1')], 1, 'src1')
    ])
    expect(sameOrder.map((h) => h.id)).toEqual(['corpus:src1:K-1', 'corpus:src1:K-9'])
  })

  it('merges a local case with a corpus hit on matching jiraKey, summing both RRF terms', () => {
    const out = fuse([
      localRanking([local('mycase', 2, 'KAN-5')]),
      corpusRanking([corpus('KAN-5', 3)])
    ])
    expect(out).toHaveLength(1)
    const merged = out[0] as LocalCaseHit
    expect(merged.kind).toBe('local')
    expect(merged.caseSlug).toBe('mycase')
    expect(merged.corpusRef).toEqual({
      sourceId: 'src1',
      key: 'KAN-5',
      url: 'https://corpus.example/browse/KAN-5'
    })
    expect(merged.provenance.map((p) => p.kind)).toEqual(['local', 'corpus'])
    expect(merged.fusedScore).toBeCloseTo(rrfScore(2) + rrfScore(3))
    expect(merged.matchedOn).toBe('both')
  })

  it('floats a merged row above an unmerged rank-1 hit', () => {
    const out = fuse([
      localRanking([local('other', 1), local('mycase', 2, 'KAN-5')]),
      corpusRanking([corpus('KAN-5', 1)])
    ])
    expect((out[0] as LocalCaseHit).caseSlug).toBe('mycase')
  })

  it('matches jiraKey case-insensitively and ignores blank keys', () => {
    const merged = fuse([
      localRanking([local('c', 1, ' kan-5 ')]),
      corpusRanking([corpus('KAN-5', 1)])
    ])
    expect(merged).toHaveLength(1)
    const notMerged = fuse([
      localRanking([local('c', 1, '  ')]),
      corpusRanking([corpus('KAN-5', 1)])
    ])
    expect(notMerged).toHaveLength(2)
  })

  it('never merges two corpus sources that share a key', () => {
    const out = fuse([
      corpusRanking([corpus('K-1', 1, 'src1')], 1, 'src1'),
      corpusRanking([corpus('K-1', 1, 'src2')], 2, 'src2')
    ])
    expect(out).toHaveLength(2)
  })

  it('does not mutate its input hits', () => {
    const hit = local('a', 1)
    fuse([localRanking([hit])])
    expect(hit.fusedScore).toBe(0)
  })

  it('returns [] for no rankings and for empty rankings', () => {
    expect(fuse([])).toEqual([])
    expect(fuse([localRanking([])])).toEqual([])
  })
})
