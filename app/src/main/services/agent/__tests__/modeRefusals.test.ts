import { describe, it, expect, vi } from 'vitest'
import { ModeRefusalRegistry } from '../modeRefusals'

describe('ModeRefusalRegistry', () => {
  it('records a refusal when the CLI adopted a different mode than requested', () => {
    const reg = new ModeRefusalRegistry()
    reg.record('claude-default', 'bypassPermissions', 'default')
    expect(reg.for('claude-default')).toEqual(['bypassPermissions'])
  })

  it('records nothing when the adopted mode matches what was requested', () => {
    const reg = new ModeRefusalRegistry()
    reg.record('claude-default', 'auto', 'auto')
    expect(reg.for('claude-default')).toEqual([])
  })

  it('records nothing when effective is null — the driver reported nothing, not a refusal', () => {
    const reg = new ModeRefusalRegistry()
    reg.record('claude-default', 'bypassPermissions', null)
    expect(reg.for('claude-default')).toEqual([])
  })

  it('records nothing when effective is undefined — a replayed pre-Task-4 transcript, same as null', () => {
    const reg = new ModeRefusalRegistry()
    // Mirror events are `JSON.parse`d with no runtime validation (mirror.ts:20), so a
    // transcript written before effectivePermissionMode existed replays as undefined, not
    // null, even though the type says `string | null`.
    reg.record('claude-default', 'bypassPermissions', undefined as unknown as null)
    expect(reg.for('claude-default')).toEqual([])
  })

  it('keeps refusals per instance — recording on one instance leaves another clean', () => {
    const reg = new ModeRefusalRegistry()
    reg.record('instance-a', 'bypassPermissions', 'default')
    expect(reg.for('instance-a')).toEqual(['bypassPermissions'])
    expect(reg.for('instance-b')).toEqual([])
  })

  it('clear() empties every instance', () => {
    const reg = new ModeRefusalRegistry()
    reg.record('instance-a', 'bypassPermissions', 'default')
    reg.record('instance-b', 'plan', 'default')
    reg.clear()
    expect(reg.for('instance-a')).toEqual([])
    expect(reg.for('instance-b')).toEqual([])
  })

  it('for() on an instance that never recorded anything returns an empty array', () => {
    const reg = new ModeRefusalRegistry()
    expect(reg.for('never-seen')).toEqual([])
  })

  it('does not add a duplicate when the same mode is refused twice', () => {
    const reg = new ModeRefusalRegistry()
    reg.record('claude-default', 'bypassPermissions', 'default')
    reg.record('claude-default', 'bypassPermissions', 'default')
    expect(reg.for('claude-default')).toEqual(['bypassPermissions'])
  })

  it('fires notify() when a NEW refusal is recorded', () => {
    const notify = vi.fn()
    const reg = new ModeRefusalRegistry({ notify })
    reg.record('claude-default', 'bypassPermissions', 'default')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('does not fire notify() again for a repeat refusal of the same mode', () => {
    const notify = vi.fn()
    const reg = new ModeRefusalRegistry({ notify })
    reg.record('claude-default', 'bypassPermissions', 'default')
    reg.record('claude-default', 'bypassPermissions', 'default')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('does not fire notify() on a no-op record (adopted mode matched, or effective null/undefined)', () => {
    const notify = vi.fn()
    const reg = new ModeRefusalRegistry({ notify })
    reg.record('claude-default', 'auto', 'auto')
    reg.record('claude-default', 'bypassPermissions', null)
    reg.record('claude-default', 'bypassPermissions', undefined as unknown as null)
    expect(notify).not.toHaveBeenCalled()
  })

  it('works without a notify dep supplied — optional, not required', () => {
    const reg = new ModeRefusalRegistry()
    expect(() => reg.record('claude-default', 'bypassPermissions', 'default')).not.toThrow()
  })
})
