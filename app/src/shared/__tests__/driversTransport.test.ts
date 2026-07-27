import { describe, it, expect } from 'vitest'
import { DRIVERS, type SystemPromptTransport } from '../drivers'

const VALID: SystemPromptTransport[] = [
  'systemPrompt.append',
  'systemMessage.append',
  'developerInstructions',
  'none',
  'unknown'
]

describe('systemPromptTransport', () => {
  it('every catalogued driver declares one, and it is a known member', () => {
    for (const [slug, d] of Object.entries(DRIVERS)) {
      expect(VALID, slug).toContain(d.capabilities.systemPromptTransport)
    }
  })

  it('no shipped driver declares "unknown" — that value is only for an unresolvable driver', () => {
    for (const [slug, d] of Object.entries(DRIVERS)) {
      expect(d.capabilities.systemPromptTransport, slug).not.toBe('unknown')
    }
  })

  it('declares the field for all five drivers, ACP pair included', () => {
    expect(DRIVERS['claude-agent-sdk'].capabilities.systemPromptTransport).toBe(
      'systemPrompt.append'
    )
    expect(DRIVERS['github-copilot'].capabilities.systemPromptTransport).toBe(
      'systemMessage.append'
    )
    expect(DRIVERS.codex.capabilities.systemPromptTransport).toBe('developerInstructions')
    // Declared degradation, not an omission: ACP `newSession` takes no system prompt and the
    // driver never reads ctx.systemAppend. Fixing that is a separate plan; declaring it is this
    // one's job.
    expect(DRIVERS.cursor.capabilities.systemPromptTransport).toBe('none')
    expect(DRIVERS.grok.capabilities.systemPromptTransport).toBe('none')
  })
})
