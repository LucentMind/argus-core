import { describe, it, expect } from 'vitest'
import { buildRunOptionQueryFields, contextWindowCapFor } from '../queryOptions'
import type { ModelOptionInfo } from '../../../../../../shared/runOptions'

const FABLE: ModelOptionInfo = {
  value: 'claude-fable-5',
  displayName: 'Fable',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportsAdaptiveThinking: true
}

describe('buildRunOptionQueryFields', () => {
  it('passes the model through untouched with no selections', () => {
    const f = buildRunOptionQueryFields(FABLE, 'claude-fable-5', [], 'default')
    expect(f.model).toBe('claude-fable-5')
    expect(f.effort).toBeUndefined()
    expect(f.settings).toBeUndefined()
    expect(f.permissionMode).toBeUndefined()
  })

  it('appends the 1m suffix to the model, not a betas array', () => {
    const f = buildRunOptionQueryFields(
      FABLE,
      'claude-fable-5',
      [{ id: 'contextWindow', value: '1m' }],
      'default'
    )
    expect(f.model).toBe('claude-fable-5[1m]')
    expect(f).not.toHaveProperty('betas')
  })

  // Fable runs at 1M on its bare slug; "200k" there is a compaction CAP delivered through the
  // CLI's `autoCompactWindow` setting (verified live 2026-09-07), NOT a model-string change.
  describe('the 200k cap on a native-1M model', () => {
    it('sends the bare slug plus settings.autoCompactWindow, and exposes the cap for the gauge', () => {
      const sel = [{ id: 'contextWindow', value: 'cap-200k' }]
      const f = buildRunOptionQueryFields(FABLE, 'claude-fable-5', sel, 'default')
      expect(f.model).toBe('claude-fable-5')
      expect(f.settings).toEqual({ autoCompactWindow: 200_000 })
      expect(contextWindowCapFor(FABLE, 'claude-fable-5', sel)).toBe(200_000)
    })

    it('exposes no cap at the default, nor for a model whose 200k is a real window', () => {
      expect(contextWindowCapFor(FABLE, 'claude-fable-5', [])).toBeUndefined()
      const OPUS: ModelOptionInfo = {
        value: 'claude-opus-5',
        displayName: 'Claude Opus 5',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        supportsFastMode: true
      }
      const sel = [{ id: 'contextWindow', value: '200k' }]
      expect(contextWindowCapFor(OPUS, 'claude-opus-5', sel)).toBeUndefined()
      expect(
        buildRunOptionQueryFields(OPUS, 'claude-opus-5', sel, 'default').settings
      ).toBeUndefined()
    })
  })

  it('sends ultracode as xhigh effort plus the settings flag', () => {
    const f = buildRunOptionQueryFields(
      FABLE,
      'claude-fable-5',
      [{ id: 'effort', value: 'ultracode' }],
      'default'
    )
    expect(f.effort).toBe('xhigh')
    expect(f.settings).toEqual({ ultracode: true })
  })

  it('never sends ultrathink to the wire — it is prompt text', () => {
    const f = buildRunOptionQueryFields(
      FABLE,
      'claude-fable-5',
      [{ id: 'effort', value: 'ultrathink' }],
      'default'
    )
    expect(f.effort).toBeUndefined()
    expect(f.settings).toBeUndefined()
  })

  it('omits permissionMode for default, matching the previous behaviour', () => {
    expect(
      buildRunOptionQueryFields(FABLE, 'claude-fable-5', [], 'default').permissionMode
    ).toBeUndefined()
  })

  // sdk.d.ts:1695 — bypassPermissions REQUIRES this flag. It is missing today.
  it('pairs bypassPermissions with allowDangerouslySkipPermissions', () => {
    const f = buildRunOptionQueryFields(FABLE, 'claude-fable-5', [], 'bypassPermissions')
    expect(f.permissionMode).toBe('bypassPermissions')
    expect(f.allowDangerouslySkipPermissions).toBe(true)
  })

  it('does not set the dangerous flag for acceptEdits', () => {
    const f = buildRunOptionQueryFields(FABLE, 'claude-fable-5', [], 'acceptEdits')
    expect(f.permissionMode).toBe('acceptEdits')
    expect(f.allowDangerouslySkipPermissions).toBeUndefined()
  })

  it('drops selections the model does not support', () => {
    const haiku: ModelOptionInfo = { value: 'haiku', displayName: 'Haiku' }
    const f = buildRunOptionQueryFields(
      haiku,
      'claude-haiku-4-5',
      [
        { id: 'effort', value: 'max' },
        { id: 'contextWindow', value: '1m' }
      ],
      'default'
    )
    expect(f.effort).toBeUndefined()
    expect(f.model).toBe('claude-haiku-4-5') // no [1m] — Haiku 400s on it
  })
})
