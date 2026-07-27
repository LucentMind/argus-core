import { describe, it, expect } from 'vitest'
import { copilotCustomAgents } from '../subagentBinding'

describe('copilotCustomAgents', () => {
  it('is undefined for an empty definition list', () => {
    expect(copilotCustomAgents([])).toBeUndefined()
  })

  it('maps tool kinds to Copilot tool names', () => {
    const agents = copilotCustomAgents([
      {
        name: 'review-correctness',
        description: 'always',
        prompt: 'BODY',
        tools: ['read', 'search', 'execute']
      }
    ])
    expect(agents).toEqual([
      {
        name: 'review-correctness',
        displayName: 'review-correctness',
        description: 'always',
        prompt: 'BODY',
        tools: ['view', 'grep', 'glob', 'bash']
      }
    ])
  })

  it('never grants the wildcard, which would hand a layer agent every write tool', () => {
    const agents = copilotCustomAgents([
      { name: 'review-security', description: 'd', prompt: 'p', tools: ['read'] }
    ])!
    expect(agents[0].tools).not.toContain('*')
  })
})
