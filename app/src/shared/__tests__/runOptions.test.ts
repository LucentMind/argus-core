import { describe, it, expect } from 'vitest'
import { descriptorsFor, type ModelOptionInfo } from '../runOptions'

const FABLE: ModelOptionInfo = {
  value: 'fable',
  resolvedModel: 'claude-fable-5',
  displayName: 'Fable',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportsAdaptiveThinking: true
}
const HAIKU: ModelOptionInfo = { value: 'haiku', displayName: 'Haiku' }

describe('descriptorsFor', () => {
  it('emits Reasoning from the reported levels, defaulting to high', () => {
    const effort = descriptorsFor(FABLE).find((d) => d.id === 'effort')
    expect(effort?.type).toBe('select')
    expect(effort && effort.type === 'select' && effort.label).toBe('Reasoning')
    const opts = effort!.type === 'select' ? effort!.options : []
    expect(opts.map((o) => o.value)).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'ultrathink'
    ])
    expect(opts.find((o) => o.isDefault)?.value).toBe('high')
    expect(opts.find((o) => o.value === 'xhigh')?.label).toBe('Extra High')
  })

  it('marks ultrathink prompt-injected, since it is text and not a flag', () => {
    const effort = descriptorsFor(FABLE).find((d) => d.id === 'effort')
    expect(effort!.type === 'select' && effort!.promptInjected).toEqual(['ultrathink'])
  })

  it('omits Ultracode when the model has no xhigh level', () => {
    const noXhigh = { ...FABLE, supportedEffortLevels: ['low', 'medium', 'high', 'max'] }
    const effort = descriptorsFor(noXhigh).find((d) => d.id === 'effort')
    const values = effort!.type === 'select' ? effort!.options.map((o) => o.value) : []
    expect(values).not.toContain('ultracode')
    expect(values).toContain('ultrathink')
  })

  // Measured: [1m] succeeds on fable/sonnet/opus (all supportsEffort) and 400s on haiku.
  it('emits Context Window exactly when the model supports effort', () => {
    expect(descriptorsFor(FABLE).some((d) => d.id === 'contextWindow')).toBe(true)
    expect(descriptorsFor(HAIKU).some((d) => d.id === 'contextWindow')).toBe(false)
  })

  it('emits fastMode and thinking only when reported', () => {
    const opus = { ...FABLE, supportsFastMode: true }
    expect(descriptorsFor(opus).some((d) => d.id === 'fastMode')).toBe(true)
    expect(descriptorsFor(FABLE).some((d) => d.id === 'fastMode')).toBe(false)
    expect(descriptorsFor(FABLE).some((d) => d.id === 'thinking')).toBe(true)
  })

  it('gives a model with no capabilities no descriptors at all', () => {
    expect(descriptorsFor(HAIKU)).toEqual([])
  })

  it('orders selects before booleans so the menu reads Reasoning, Context, then toggles', () => {
    const ids = descriptorsFor({ ...FABLE, supportsFastMode: true }).map((d) => d.id)
    expect(ids).toEqual(['effort', 'contextWindow', 'fastMode', 'thinking'])
  })
})
