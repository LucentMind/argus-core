import { describe, it, expect } from 'vitest'
import { claudeAgentsOption } from '../subagentBinding'

describe('claudeAgentsOption', () => {
  it('is undefined for an empty definition list, so the key is omitted entirely', () => {
    expect(claudeAgentsOption([])).toBeUndefined()
  })

  it('keys agents by name and maps tool kinds to Claude tool ids', () => {
    const agents = claudeAgentsOption([
      {
        name: 'review-security',
        description: 'when auth changes',
        prompt: 'BODY',
        tools: ['read', 'search', 'execute']
      }
    ])
    expect(agents).toEqual({
      'review-security': {
        description: 'when auth changes',
        prompt: 'BODY',
        tools: ['Read', 'Grep', 'Glob', 'Bash']
      }
    })
  })

  it('never grants a findings or edit tool', () => {
    const agents = claudeAgentsOption([
      { name: 'review-tests', description: 'd', prompt: 'p', tools: ['read'] }
    ])!
    const tools = agents['review-tests'].tools
    expect(tools).not.toContain('Write')
    expect(tools).not.toContain('Edit')
    expect(tools.some((t) => t.startsWith('mcp__argus__'))).toBe(false)
  })
})
