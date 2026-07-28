import { describe, it, expect } from 'vitest'
import { NATIVE_TOOL_SPECS } from '../nativeTools'
import { NATIVE_RISK } from '../risk'

describe('fetch_check_logs registration', () => {
  it('is advertised with a check_name argument', () => {
    const spec = NATIVE_TOOL_SPECS.find((s) => s.name === 'fetch_check_logs')!
    expect(spec).toBeDefined()
    expect(Object.keys(spec.schema)).toEqual(['check_name'])
    expect(spec.description).toMatch(/check/i)
  })

  it('auto-runs at LOW risk — spec §8 says reads auto-run and are logged', () => {
    expect(NATIVE_RISK['mcp__argus__fetch_check_logs']).toEqual({ action: 'allow', risk: 'LOW' })
  })

  it('is not editable — it takes no reviewed prose', async () => {
    const { isEditableTool } = await import('../../../../shared/editableTools')
    expect(isEditableTool('mcp__argus__fetch_check_logs')).toBe(false)
  })
})
