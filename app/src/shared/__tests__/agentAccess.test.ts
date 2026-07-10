import { describe, it, expect } from 'vitest'
import { agentAccessSchema, defaultAgentAccess, skillEnabled, topicEnabled } from '../agentAccess'

describe('agentAccessSchema', () => {
  it('defaults to empty sparse maps', () => {
    const a = defaultAgentAccess()
    expect(a.skills).toEqual({})
    expect(a.memory).toEqual({})
  })

  it('absent keys mean enabled; explicit false disables', () => {
    const a = agentAccessSchema.parse({ skills: { 'bundled/rca': false } })
    expect(skillEnabled(a, 'bundled/rca')).toBe(false)
    expect(skillEnabled(a, 'bundled/analyze-applog')).toBe(true)
    expect(topicEnabled(a, 'anything')).toBe(true)
  })

  it('round-trips unknown keys (looseObject)', () => {
    const a = agentAccessSchema.parse({ skills: {}, memory: {}, futureSection: { x: 1 } })
    expect((a as Record<string, unknown>).futureSection).toEqual({ x: 1 })
  })
})
