import { describe, it, expect } from 'vitest'
import { prFaceOf, type PrStatus } from '../prStatus'

const BASE: PrStatus = {
  owner: 'o',
  repo: 'r',
  number: 7,
  url: 'https://example.test/pr/7',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  rollup: 'passing',
  checks: [],
  fetchedAt: '2026-08-01T10:00:00.000Z',
  error: null
}

describe('prFaceOf', () => {
  it('falls through to the CI rollup for an ordinary open PR', () => {
    expect(prFaceOf(BASE)).toBe('passing')
    expect(prFaceOf({ ...BASE, rollup: 'failing' })).toBe('failing')
    expect(prFaceOf({ ...BASE, rollup: 'running' })).toBe('running')
    expect(prFaceOf({ ...BASE, rollup: 'unstable' })).toBe('unstable')
    expect(prFaceOf({ ...BASE, rollup: 'none' })).toBe('none')
    expect(prFaceOf({ ...BASE, rollup: 'unavailable' })).toBe('unavailable')
  })

  it('reports a merged PR as merged whatever its checks say', () => {
    expect(prFaceOf({ ...BASE, state: 'MERGED', rollup: 'failing' })).toBe('merged')
  })

  it('reports a closed-unmerged PR as closed', () => {
    expect(prFaceOf({ ...BASE, state: 'CLOSED', rollup: 'passing' })).toBe('closed')
  })

  it('reports a conflict over a failing build — you must rebase either way', () => {
    expect(prFaceOf({ ...BASE, mergeable: 'CONFLICTING', rollup: 'failing' })).toBe('conflict')
  })

  it('ranks merged above a conflict', () => {
    expect(prFaceOf({ ...BASE, state: 'MERGED', mergeable: 'CONFLICTING' })).toBe('merged')
  })

  it('reports a draft over its CI verdict', () => {
    expect(prFaceOf({ ...BASE, isDraft: true, rollup: 'failing' })).toBe('draft')
  })

  it('ranks a conflict above a draft', () => {
    expect(prFaceOf({ ...BASE, isDraft: true, mergeable: 'CONFLICTING' })).toBe('conflict')
  })
})
