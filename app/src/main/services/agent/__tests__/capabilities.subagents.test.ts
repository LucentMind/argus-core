import { describe, it, expect } from 'vitest'
import { DRIVERS } from '../../../../shared/drivers'
import { getDriverByKind } from '../driverRegistry'

const EXPECTED: Record<string, 'configurable' | 'promptable'> = {
  'claude-agent-sdk': 'configurable',
  'github-copilot': 'configurable',
  codex: 'promptable',
  cursor: 'promptable',
  grok: 'promptable'
}

describe('subagents capability', () => {
  it('declares a value for every registered driver', () => {
    for (const def of Object.values(DRIVERS)) {
      expect(EXPECTED[def.kind], `unmapped driver kind ${def.kind}`).toBeDefined()
      expect(def.capabilities.subagents).toBe(EXPECTED[def.kind])
    }
  })

  it('keeps the main-side driver and the shared mirror in agreement', () => {
    for (const def of Object.values(DRIVERS)) {
      const driver = getDriverByKind(def.kind)
      expect(driver.capabilities.subagents).toBe(def.capabilities.subagents)
    }
  })
})
