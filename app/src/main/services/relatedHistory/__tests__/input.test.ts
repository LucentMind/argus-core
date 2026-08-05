import { describe, it, expect } from 'vitest'
import { validateRelatedSearchInput } from '../input'

describe('validateRelatedSearchInput', () => {
  it('accepts a bare case-scoped request', () => {
    expect(validateRelatedSearchInput({ caseSlug: 'ecu-dlt-drift' })).toEqual({
      caseSlug: 'ecu-dlt-drift'
    })
  })

  it('rejects a non-object payload', () => {
    expect(() => validateRelatedSearchInput(null)).toThrow(/Invalid related search input/)
    expect(() => validateRelatedSearchInput('q')).toThrow(/Invalid related search input/)
  })

  it('rejects a bad slug the same way every case handler does', () => {
    expect(() => validateRelatedSearchInput({ caseSlug: '../etc' })).toThrow(/Invalid case slug/)
  })

  it('clamps limit into [1, 50] and drops a non-finite one', () => {
    expect(validateRelatedSearchInput({ query: 'x', limit: 999 }).limit).toBe(50)
    expect(validateRelatedSearchInput({ query: 'x', limit: 0 }).limit).toBe(1)
    expect(validateRelatedSearchInput({ query: 'x', limit: 7.8 }).limit).toBe(7)
    expect(validateRelatedSearchInput({ query: 'x', limit: Number.NaN }).limit).toBeUndefined()
  })

  it('caps query length instead of forwarding an unbounded string', () => {
    const out = validateRelatedSearchInput({ query: 'a'.repeat(5000) })
    expect(out.query).toHaveLength(2000)
  })

  it('rejects an unknown mode', () => {
    expect(() => validateRelatedSearchInput({ query: 'x', mode: 'magic' })).toThrow(/mode/)
  })

  it('keeps only known filter keys, string entries, and a bounded list', () => {
    const out = validateRelatedSearchInput({
      query: 'x',
      filters: {
        projects: ['KAN', '', 'NAV', 42],
        nonsense: ['drop me'],
        updatedAfter: '2026-01-01T00:00:00.000Z'
      }
    })
    expect(out.filters).toEqual({
      projects: ['KAN', 'NAV'],
      updatedAfter: '2026-01-01T00:00:00.000Z'
    })
  })

  it('drops a filter key whose surviving list is empty rather than sending []', () => {
    const out = validateRelatedSearchInput({ query: 'x', filters: { projects: ['', '  '] } })
    expect(out.filters).toBeUndefined()
  })

  it('rejects an updatedAfter that is not a parseable timestamp', () => {
    expect(() =>
      validateRelatedSearchInput({ query: 'x', filters: { updatedAfter: 'yesterday' } })
    ).toThrow(/updatedAfter/)
  })

  it('normalizes includeOpenCases and providerIds', () => {
    const out = validateRelatedSearchInput({
      query: 'x',
      includeOpenCases: true,
      providerIds: ['local', 'corpus:src1', '', 9]
    })
    expect(out.includeOpenCases).toBe(true)
    expect(out.providerIds).toEqual(['local', 'corpus:src1'])
  })

  it('requires at least one of caseSlug / query', () => {
    expect(() => validateRelatedSearchInput({ limit: 5 })).toThrow(/caseSlug or query/)
  })
})
