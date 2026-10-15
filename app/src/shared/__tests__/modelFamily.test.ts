import { describe, it, expect } from 'vitest'
import {
  compareVersions,
  sortByFamily,
  isLegacyRow,
  legacyModelKeys,
  normalizeModelKey,
  parseClaudeModel
} from '../modelFamily'

describe('normalizeModelKey', () => {
  it('strips the 1M suffix and the CLI build date', () => {
    expect(normalizeModelKey('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(normalizeModelKey('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(normalizeModelKey('claude-sonnet-5-5-20260901[1m]')).toBe('claude-sonnet-5-5')
  })

  it('leaves a bare slug and a non-Claude id untouched', () => {
    expect(normalizeModelKey('claude-opus-5')).toBe('claude-opus-5')
    expect(normalizeModelKey('auto')).toBe('auto')
  })
})

describe('parseClaudeModel', () => {
  it('reads family and a multi-part version', () => {
    expect(parseClaudeModel('claude-opus-5-5')).toEqual({ family: 'opus', version: [5, 5] })
    expect(parseClaudeModel('claude-opus-5')).toEqual({ family: 'opus', version: [5] })
    expect(parseClaudeModel('claude-fable-5-1')).toEqual({ family: 'fable', version: [5, 1] })
  })

  it('ignores [1m] and a trailing build date', () => {
    expect(parseClaudeModel('claude-opus-5-5[1m]')).toEqual({ family: 'opus', version: [5, 5] })
    expect(parseClaudeModel('claude-haiku-4-5-20251001')).toEqual({
      family: 'haiku',
      version: [4, 5]
    })
  })

  it('returns null for aliases, custom ids and other providers', () => {
    expect(parseClaudeModel('default')).toBeNull()
    expect(parseClaudeModel('opus[1m]')).toBeNull()
    expect(parseClaudeModel('auto')).toBeNull()
    expect(parseClaudeModel('gpt-5')).toBeNull()
    expect(parseClaudeModel('claude-3-5-sonnet-20241022')).toBeNull()
    expect(parseClaudeModel('claude-mystery-9')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('compares part by part, a missing part counting as 0', () => {
    expect(compareVersions([5, 5], [5])).toBeGreaterThan(0)
    expect(compareVersions([5], [5, 5])).toBeLessThan(0)
    expect(compareVersions([5], [5, 0])).toBe(0)
    expect(compareVersions([4, 8], [5])).toBeLessThan(0)
    expect(compareVersions([4, 10], [4, 9])).toBeGreaterThan(0)
  })
})

describe('legacyModelKeys', () => {
  const slugs = [
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-haiku-5-5',
    'claude-haiku-4-5'
  ].map((slug) => ({ slug }))

  it('keeps the newest two versions per family and flags the rest', () => {
    expect([...legacyModelKeys(slugs)].sort()).toEqual([
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-4-6'
    ])
  })

  it('does not depend on row order', () => {
    expect([...legacyModelKeys([...slugs].reverse())].sort()).toEqual([
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-4-6'
    ])
  })

  it('counts a model once however many rows name it', () => {
    const rows = [
      { slug: 'default', resolvedModel: 'claude-opus-5-5[1m]' },
      { slug: 'claude-opus-5-5' },
      { slug: 'opus', resolvedModel: 'claude-opus-5' },
      { slug: 'claude-opus-4-8' }
    ]
    expect([...legacyModelKeys(rows)]).toEqual(['claude-opus-4-8'])
  })

  it('reads the wire slug from resolvedModel on alias-keyed rows', () => {
    const rows = [
      { slug: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]' },
      { slug: 'sonnet', resolvedModel: 'claude-sonnet-5-5' },
      { slug: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' }
    ]
    expect(legacyModelKeys(rows).size).toBe(0)
  })

  it('never ranks, and never flags, custom rows or unparsable slugs', () => {
    const rows = [
      { slug: 'claude-opus-5-5' },
      { slug: 'claude-opus-5' },
      { slug: 'claude-opus-9', isCustom: true },
      { slug: 'claude-opus-4-8' },
      { slug: 'auto' }
    ]
    expect([...legacyModelKeys(rows)]).toEqual(['claude-opus-4-8'])
  })

  it('honours a different keep count', () => {
    expect([...legacyModelKeys(slugs, 1)]).toContain('claude-opus-5')
    expect(legacyModelKeys(slugs, 3).has('claude-opus-4-8')).toBe(false)
  })
})

describe('isLegacyRow', () => {
  const legacy = new Set(['claude-opus-4-8'])

  it('matches by slug or resolvedModel, ignoring [1m] and dates', () => {
    expect(isLegacyRow({ slug: 'claude-opus-4-8' }, legacy)).toBe(true)
    expect(isLegacyRow({ slug: 'opus', resolvedModel: 'claude-opus-4-8[1m]' }, legacy)).toBe(true)
    expect(isLegacyRow({ slug: 'claude-opus-5-5' }, legacy)).toBe(false)
  })

  it('is false for a custom row even when its slug is legacy', () => {
    expect(isLegacyRow({ slug: 'claude-opus-4-8', isCustom: true }, legacy)).toBe(false)
  })
})

describe('sortByFamily', () => {
  it('groups by family (opus, fable, sonnet, haiku), newest version first inside each', () => {
    const rows = [
      { slug: 'claude-haiku-4-5' },
      { slug: 'claude-opus-4-8' },
      { slug: 'claude-sonnet-5' },
      { slug: 'claude-opus-5-5' },
      { slug: 'claude-fable-5' },
      { slug: 'claude-haiku-5-5' },
      { slug: 'claude-fable-5-1' },
      { slug: 'claude-sonnet-5-5' }
    ]
    expect(sortByFamily(rows).map((r) => r.slug)).toEqual([
      'claude-opus-5-5',
      'claude-opus-4-8',
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-haiku-5-5',
      'claude-haiku-4-5'
    ])
  })

  it('reads the wire slug from resolvedModel on alias-keyed rows', () => {
    const rows = [
      { slug: 'sonnet', resolvedModel: 'claude-sonnet-5' },
      { slug: 'opus', resolvedModel: 'claude-opus-5-5' }
    ]
    expect(sortByFamily(rows).map((r) => r.slug)).toEqual(['opus', 'sonnet'])
  })

  it('leaves rows it cannot place exactly where they were', () => {
    const rows = [
      { slug: 'auto' },
      { slug: 'claude-haiku-4-5' },
      { slug: 'my-finetune', isCustom: true },
      { slug: 'claude-opus-5-5' }
    ]
    expect(sortByFamily(rows).map((r) => r.slug)).toEqual([
      'auto',
      'claude-opus-5-5',
      'my-finetune',
      'claude-haiku-4-5'
    ])
  })

  it('is stable for rows that tie', () => {
    const rows = [{ slug: 'opus', resolvedModel: 'claude-opus-5-5' }, { slug: 'claude-opus-5-5' }]
    expect(sortByFamily(rows).map((r) => r.slug)).toEqual(['opus', 'claude-opus-5-5'])
  })
})
