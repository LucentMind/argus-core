import { describe, it, expect } from 'vitest'
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'

describe('sdk surface', () => {
  it('exports the entry points the agent layer builds on', () => {
    expect(typeof query).toBe('function')
    expect(typeof createSdkMcpServer).toBe('function')
    expect(typeof tool).toBe('function')
  })
})
