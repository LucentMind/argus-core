import { describe, it, expect } from 'vitest'
import {
  descriptorsFor,
  selectionValue,
  pruneSelections,
  selectionLabel,
  effectiveEffort,
  apiModelId,
  claudeSettingsFor,
  type ModelOptionInfo,
  type RunOptionDescriptor
} from '../runOptions'

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

  it('emits Context Window with exactly two choices in the correct order and defaults', () => {
    const descriptor = descriptorsFor(FABLE).find((d) => d.id === 'contextWindow')
    expect(descriptor?.type).toBe('select')
    if (descriptor?.type === 'select') {
      expect(descriptor.options).toEqual([
        { value: '200k', label: '200k', isDefault: true },
        { value: '1m', label: '1M' }
      ])
    }
  })

  it('defaults effort to the first level when high is not available', () => {
    const noHigh = { ...FABLE, supportedEffortLevels: ['low', 'medium', 'xhigh', 'max'] }
    const effort = descriptorsFor(noHigh).find((d) => d.id === 'effort')
    expect(effort?.type).toBe('select')
    if (effort?.type === 'select') {
      const defaultOption = effort.options.find((o) => o.isDefault)
      expect(defaultOption?.value).toBe('low')
    }
  })
})

describe('selectionValue', () => {
  const [effort, ctx] = descriptorsFor(FABLE)

  it('returns the stored value when it is valid for this model', () => {
    expect(selectionValue(effort, [{ id: 'effort', value: 'max' }])).toBe('max')
  })

  it('falls back to the default when nothing is stored', () => {
    expect(selectionValue(effort, null)).toBe('high')
    expect(selectionValue(ctx, [])).toBe('200k')
  })

  // The stale-drop rule: a value the current model does not offer must not stick.
  it('drops a stored value the current model does not offer', () => {
    expect(selectionValue(effort, [{ id: 'effort', value: 'nonsense' }])).toBe('high')
  })

  it('treats a boolean descriptor as off unless explicitly stored true', () => {
    const fast = descriptorsFor({ ...FABLE, supportsFastMode: true }).find(
      (d) => d.id === 'fastMode'
    )!
    expect(selectionValue(fast, null)).toBe(false)
    expect(selectionValue(fast, [{ id: 'fastMode', value: true }])).toBe(true)
    // a string stored against a boolean descriptor is garbage, not truthy
    expect(selectionValue(fast, [{ id: 'fastMode', value: 'yes' }])).toBe(false)
  })
})

describe('pruneSelections', () => {
  it('keeps only ids and values valid for the current descriptors', () => {
    const ds = descriptorsFor(FABLE)
    const stored = [
      { id: 'effort', value: 'max' },
      { id: 'fastMode', value: true }, // not a descriptor on Fable
      { id: 'contextWindow', value: 'nonsense' }
    ]
    expect(pruneSelections(ds, stored)).toEqual([{ id: 'effort', value: 'max' }])
  })

  it('returns an empty array for a model with no descriptors', () => {
    expect(pruneSelections(descriptorsFor(HAIKU), [{ id: 'effort', value: 'max' }])).toEqual([])
  })

  it('omits values that merely equal the default, so defaults can move later', () => {
    const ds = descriptorsFor(FABLE)
    expect(pruneSelections(ds, [{ id: 'effort', value: 'high' }])).toEqual([])
  })
})

describe('selectionLabel', () => {
  it('gives the chip its text', () => {
    const [effort] = descriptorsFor(FABLE)
    expect(selectionLabel(effort, [{ id: 'effort', value: 'xhigh' }])).toBe('Extra High')
    expect(selectionLabel(effort, null)).toBe('High')
  })

  it('renders booleans as On and Off', () => {
    const fast = descriptorsFor({ ...FABLE, supportsFastMode: true }).find(
      (d) => d.id === 'fastMode'
    )!
    expect(selectionLabel(fast, [{ id: 'fastMode', value: true }])).toBe('On')
    expect(selectionLabel(fast, null)).toBe('Off')
  })
})

describe('effectiveEffort', () => {
  const [effort] = descriptorsFor(FABLE)

  it('passes a real level straight through', () => {
    expect(effectiveEffort(effort, 'max')).toBe('max')
  })

  // ultracode is a Settings key, not an effort level; it pairs with xhigh.
  it('maps ultracode to xhigh', () => {
    expect(effectiveEffort(effort, 'ultracode')).toBe('xhigh')
  })

  // ultrathink is prompt text and must never reach the wire as an effort.
  it('drops ultrathink entirely', () => {
    expect(effectiveEffort(effort, 'ultrathink')).toBeUndefined()
  })

  it('degrades a level this model does not support down to the nearest supported one', () => {
    const [noXhigh] = descriptorsFor({
      ...FABLE,
      supportedEffortLevels: ['low', 'medium', 'high']
    })
    expect(effectiveEffort(noXhigh, 'max')).toBe('high')
  })

  it('is undefined when there is no effort descriptor at all', () => {
    expect(effectiveEffort(undefined, 'high')).toBeUndefined()
  })

  it('rounds up to the model\'s lowest level when nothing supported lies below the request', () => {
    const [noLow] = descriptorsFor({
      ...FABLE,
      supportedEffortLevels: ['medium', 'high', 'xhigh', 'max']
    })
    expect(effectiveEffort(noLow, 'low')).toBe('medium')
  })

  it('returns undefined when the descriptor contains no real effort levels', () => {
    const noEffort: RunOptionDescriptor = {
      type: 'select',
      id: 'effort',
      label: 'Reasoning',
      options: [{ value: 'weird', label: 'Weird' }]
    }
    expect(effectiveEffort(noEffort, 'weird')).toBeUndefined()
  })
})

describe('apiModelId', () => {
  it('appends the 1m suffix', () => {
    expect(apiModelId('claude-opus-5', '1m')).toBe('claude-opus-5[1m]')
  })

  it('leaves 200k and absent alone', () => {
    expect(apiModelId('claude-opus-5', '200k')).toBe('claude-opus-5')
    expect(apiModelId('claude-opus-5', undefined)).toBe('claude-opus-5')
  })

  it('never double-suffixes an already-suffixed slug', () => {
    expect(apiModelId('claude-opus-5[1m]', '1m')).toBe('claude-opus-5[1m]')
  })
})

describe('claudeSettingsFor', () => {
  it('is empty when nothing is selected', () => {
    expect(claudeSettingsFor(descriptorsFor(FABLE), null)).toEqual({})
  })

  it('sets ultracode when the effort selection is ultracode', () => {
    const ds = descriptorsFor(FABLE)
    expect(claudeSettingsFor(ds, [{ id: 'effort', value: 'ultracode' }])).toEqual({
      ultracode: true
    })
  })

  it('carries fastMode and thinking', () => {
    const ds = descriptorsFor({ ...FABLE, supportsFastMode: true })
    expect(
      claudeSettingsFor(ds, [
        { id: 'fastMode', value: true },
        { id: 'thinking', value: true }
      ])
    ).toEqual({ fastMode: true, alwaysThinkingEnabled: true })
  })
})
