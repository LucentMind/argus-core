import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createSession, setSessionPermissionMode } from '../sessionStore'
import { ModeRefusalRegistry, recordRefusalFor } from '../modeRefusals'

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

  it('records a mismatch even when requested is "default" — the registry itself is dumb string-equality, no mode is special-cased here; the "default is never a real request" judgment is recordRefusalFor\'s job, not this class\'s (see the "regression (Finding 1)" test in the recordRefusalFor describe block below)', () => {
    const reg = new ModeRefusalRegistry()
    reg.record('claude-default', 'default', 'acceptEdits')
    expect(reg.for('claude-default')).toEqual(['default'])
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

describe('recordRefusalFor', () => {
  let tmp: string, db: DatabaseSync

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mr-'))
    db = openDb(path.join(tmp, 'argus.db'))
    createCase(db, path.join(tmp, 'home'), { slug: 'NAV-1', title: 't' })
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("records a refusal on the session's instance when the CLI adopted something else", () => {
    const s = createSession(db, 'NAV-1', {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-default',
      model: 'claude-opus-4-8'
    })
    setSessionPermissionMode(db, s.id, 'bypassPermissions')
    const registry = new ModeRefusalRegistry()

    recordRefusalFor(
      { db, registry, defaultPermissionMode: 'default' },
      { sessionId: s.id, effectivePermissionMode: 'default' }
    )

    expect(registry.for('claude-default')).toEqual(['bypassPermissions'])
  })

  it('falls back to the settings default when the session never pinned a mode — same fallback as registry.ts', () => {
    const s = createSession(db, 'NAV-1', {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-default',
      model: 'claude-opus-4-8'
    })
    // Session never called setSessionPermissionMode — permission_mode stays null.
    const registry = new ModeRefusalRegistry()

    recordRefusalFor(
      { db, registry, defaultPermissionMode: 'acceptEdits' },
      { sessionId: s.id, effectivePermissionMode: 'bypassPermissions' }
    )

    // Requested resolves to the settings default ('acceptEdits'), which mismatches the
    // adopted 'bypassPermissions' — recorded as a refusal of 'acceptEdits', not 'default'.
    expect(registry.for('claude-default')).toEqual(['acceptEdits'])
  })

  it('regression (Finding 1): a session that never pinned a mode, on a CLI whose configured default is not "default", is NOT recorded as refusing "default"', () => {
    const s = createSession(db, 'NAV-1', {
      driverKind: 'claude-agent-sdk',
      instanceId: 'claude-default',
      model: 'claude-opus-4-8'
    })
    // No pin, and the settings default is itself 'default' — the case queryOptions.ts omits
    // permissionMode entirely, letting an enterprise-managed CLI adopt its own configured
    // default (here simulated as 'acceptEdits').
    const registry = new ModeRefusalRegistry()

    recordRefusalFor(
      { db, registry, defaultPermissionMode: 'default' },
      { sessionId: s.id, effectivePermissionMode: 'acceptEdits' }
    )

    expect(registry.for('claude-default')).toEqual([])
  })

  it('is a no-op when the session has no known provider instance (pre-multi-provider row)', () => {
    const s = createSession(db, 'NAV-1', 'claude-agent-sdk') // legacy string form: instance_id stays NULL
    const registry = new ModeRefusalRegistry()
    const recordSpy = vi.spyOn(registry, 'record')

    recordRefusalFor(
      { db, registry, defaultPermissionMode: 'default' },
      { sessionId: s.id, effectivePermissionMode: 'acceptEdits' }
    )

    expect(recordSpy).not.toHaveBeenCalled()
  })
})
