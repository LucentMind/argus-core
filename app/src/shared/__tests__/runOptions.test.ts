import { describe, it, expect } from 'vitest'
import {
  descriptorsFor,
  selectionValue,
  pruneSelections,
  selectionLabel,
  effectiveEffort,
  apiModelId,
  claudeSettingsFor,
  hasUltrathink,
  applyUltrathink,
  stripUltrathink,
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
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
      'ultrathink'
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

  it('emits fastMode only when reported', () => {
    const opus = { ...FABLE, supportsFastMode: true }
    expect(descriptorsFor(opus).some((d) => d.id === 'fastMode')).toBe(true)
    expect(descriptorsFor(FABLE).some((d) => d.id === 'fastMode')).toBe(false)
  })

  // The curation, not a capability gap: Fable DOES report `supportsAdaptiveThinking`, and a
  // wire capture confirms the toggle works on it. Reasoning already spans the same axis more
  // expressively, so a model that has Reasoning does not also get Thinking.
  it('withholds Thinking from a model that has a Reasoning control', () => {
    expect(descriptorsFor(FABLE).some((d) => d.id === 'thinking')).toBe(false)
    expect(descriptorsFor({ ...FABLE, supportsAdaptiveThinking: true }).map((d) => d.id)).toEqual([
      'effort',
      'contextWindow'
    ])
  })

  // Haiku reports NO capability flags at all, yet a 2026-08-03 ANTHROPIC_BASE_URL capture shows
  // it honouring the toggle on the wire: unset sends `{"type":"enabled","budget_tokens":31999}`
  // and `alwaysThinkingEnabled:false` sends `{"type":"disabled"}`. So an effort-less model gets
  // the one control it can actually use, rather than an empty menu.
  it('gives a model with no Reasoning control a Thinking toggle', () => {
    expect(descriptorsFor(HAIKU)).toEqual([
      { type: 'boolean', id: 'thinking', label: 'Thinking', defaultOn: true }
    ])
  })

  it('orders selects before booleans so the menu reads Reasoning, Context, then toggles', () => {
    const ids = descriptorsFor({ ...FABLE, supportsFastMode: true }).map((d) => d.id)
    expect(ids).toEqual(['effort', 'contextWindow', 'fastMode'])
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

  // A model pinned AT the [1m] suffix has no 200k position: `apiModelId` cannot strip a suffix
  // the slug already carries, so the choice was inert — it rendered as the default and the
  // selected value while every send went out at 1M. The CLI's `opus[1m]` alias row is the case
  // that made this reachable in the picker; a hand-added custom `claude-sonnet-5[1m]` is the
  // other. Keyed off the MODEL, not the row: a session pinned to `claude-fable-5[1m]` resolves
  // to the bare `fable` row, and would otherwise keep an inert 200k too.
  describe('a model pinned at the 1M suffix', () => {
    it('offers 1M alone, as the default', () => {
      const d = descriptorsFor(FABLE, 'claude-fable-5[1m]').find((x) => x.id === 'contextWindow')
      expect(d?.type).toBe('select')
      if (d?.type === 'select') {
        expect(d.options).toEqual([{ value: '1m', label: '1M', isDefault: true }])
      }
    })

    it('applies to the CLI alias row whose own value carries the suffix', () => {
      const opusAlias: ModelOptionInfo = {
        value: 'opus[1m]',
        resolvedModel: 'claude-opus-5[1m]',
        displayName: 'Opus (1M context)',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
      }
      const d = descriptorsFor(opusAlias, 'opus[1m]').find((x) => x.id === 'contextWindow')
      if (d?.type === 'select') expect(d.options.map((o) => o.value)).toEqual(['1m'])
    })

    it('resolves a stored 200k to 1M rather than reporting a window that is not in use', () => {
      const d = descriptorsFor(FABLE, 'claude-fable-5[1m]').find((x) => x.id === 'contextWindow')!
      expect(selectionValue(d, [{ id: 'contextWindow', value: '200k' }])).toBe('1m')
      expect(selectionLabel(d, [{ id: 'contextWindow', value: '200k' }])).toBe('1M')
      // and nothing is persisted, since the only value equals the default
      expect(pruneSelections([d], [{ id: 'contextWindow', value: '1m' }])).toEqual([])
    })

    it('leaves the bare slug alone — that one really can choose', () => {
      const d = descriptorsFor(FABLE, 'claude-fable-5').find((x) => x.id === 'contextWindow')
      if (d?.type === 'select') expect(d.options.map((o) => o.value)).toEqual(['200k', '1m'])
      // omitting the model entirely is the same as a bare one, so old call sites are unaffected
      const noModel = descriptorsFor(FABLE).find((x) => x.id === 'contextWindow')
      expect(noModel).toEqual(d)
    })
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

  // Inverted control: alwaysThinkingEnabled is ON when absent, so an unset Thinking toggle
  // that read `false` was reporting the opposite of what the wire does.
  it('treats a defaultOn boolean as ON until it is explicitly stored false', () => {
    const thinking = descriptorsFor(HAIKU).find((d) => d.id === 'thinking')!
    expect(selectionValue(thinking, null)).toBe(true)
    expect(selectionValue(thinking, [])).toBe(true)
    expect(selectionValue(thinking, [{ id: 'thinking', value: false }])).toBe(false)
    expect(selectionValue(thinking, [{ id: 'thinking', value: true }])).toBe(true)
    // garbage falls back to the descriptor's default, not to false
    expect(selectionValue(thinking, [{ id: 'thinking', value: 'no' }])).toBe(true)
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

  // Same "store only what differs from the default" rule, applied to the inverted toggle:
  // for Thinking it is `false` that is worth persisting and `true` that is the no-op.
  it('persists the off half of a defaultOn boolean and drops the on half', () => {
    const ds = descriptorsFor(HAIKU)
    expect(pruneSelections(ds, [{ id: 'thinking', value: false }])).toEqual([
      { id: 'thinking', value: false }
    ])
    expect(pruneSelections(ds, [{ id: 'thinking', value: true }])).toEqual([])
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

  it('labels an unset defaultOn boolean "On", not "Off"', () => {
    const thinking = descriptorsFor(HAIKU).find((d) => d.id === 'thinking')!
    expect(selectionLabel(thinking, null)).toBe('On')
    expect(selectionLabel(thinking, [{ id: 'thinking', value: false }])).toBe('Off')
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

  it("rounds up to the model's lowest level when nothing supported lies below the request", () => {
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

  it('carries fastMode', () => {
    const ds = descriptorsFor({ ...FABLE, supportsFastMode: true })
    expect(claudeSettingsFor(ds, [{ id: 'fastMode', value: true }])).toEqual({ fastMode: true })
  })

  // Per the SDK, absent and `true` both mean thinking is ON — only `false` says anything. So
  // the ONLY value worth sending is `false`, and the old `alwaysThinkingEnabled: true` write
  // made both chip positions no-ops on the wire.
  it('sends alwaysThinkingEnabled only to turn thinking OFF', () => {
    const ds = descriptorsFor(HAIKU)
    expect(claudeSettingsFor(ds, [{ id: 'thinking', value: false }])).toEqual({
      alwaysThinkingEnabled: false
    })
  })

  it('sends nothing for thinking when it is on, whether stored or merely unset', () => {
    const ds = descriptorsFor(HAIKU)
    expect(claudeSettingsFor(ds, null)).toEqual({})
    expect(claudeSettingsFor(ds, [{ id: 'thinking', value: true }])).toEqual({})
  })
})

describe('ultrathink prompt helpers', () => {
  it('detects the word anywhere, case-insensitively', () => {
    expect(hasUltrathink('Ultrathink:\nfix the bug')).toBe(true)
    expect(hasUltrathink('please ULTRATHINK about this')).toBe(true)
    expect(hasUltrathink('fix the bug')).toBe(false)
  })

  it('does not fire on a word that merely contains it', () => {
    expect(hasUltrathink('ultrathinking')).toBe(false)
  })

  it('prefixes an existing draft', () => {
    expect(applyUltrathink('fix the bug')).toBe('Ultrathink:\nfix the bug')
  })

  it('seeds an empty draft with just the prefix, so the chip has something to show', () => {
    expect(applyUltrathink('')).toBe('Ultrathink:\n')
    expect(applyUltrathink('   ')).toBe('Ultrathink:\n')
  })

  it('is idempotent', () => {
    expect(applyUltrathink('Ultrathink:\nfix it')).toBe('Ultrathink:\nfix it')
  })

  it('strips only our prefix, never the word from the body', () => {
    expect(stripUltrathink('Ultrathink:\nfix it')).toBe('fix it')
    expect(stripUltrathink('please ultrathink here')).toBe('please ultrathink here')
  })
})
