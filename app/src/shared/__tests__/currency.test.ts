import { describe, it, expect } from 'vitest'
import { blockedOf, type Candidate } from '../currency'
import { settingsSchema } from '../settings'

const clean: Candidate = {
  domain: 'pack',
  key: 'code-graph',
  label: 'Code Graph',
  from: '1.0.0',
  to: '1.1.0',
  verdict: 'clean'
}
const blocked: Candidate = {
  domain: 'hive-reference',
  key: 'reference/style.md',
  label: 'style.md',
  from: 'abc123',
  to: 'def456',
  verdict: 'blocked',
  reason: { kind: 'local-edits' }
}

describe('blockedOf', () => {
  it('keeps only blocked candidates', () => {
    expect(blockedOf([clean, blocked])).toEqual([blocked])
  })

  it('is empty when everything is clean', () => {
    expect(blockedOf([clean])).toEqual([])
  })
})

describe('updates.auto', () => {
  it('defaults to true', () => {
    expect(settingsSchema.parse({}).updates.auto).toBe(true)
  })

  it('round-trips false', () => {
    expect(settingsSchema.parse({ updates: { auto: false } }).updates.auto).toBe(false)
  })

  it('still defaults the whole section from an empty object', () => {
    expect(settingsSchema.parse({ updates: {} }).updates).toEqual({ channel: 'stable', auto: true })
  })
})
