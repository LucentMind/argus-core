import { describe, expect, it } from 'vitest'
import { codexApprovalGen, mapCodexDecision, synthesizeCodexApproval } from '../mapping'
import { CODEX_TOOL_TAXONOMY } from '../taxonomy'
import { classifyToolCall } from '../../../risk'

describe('codexApprovalGen', () => {
  it('classifies current-gen item/... methods', () => {
    expect(codexApprovalGen('item/commandExecution/requestApproval')).toBe('current')
    expect(codexApprovalGen('item/fileChange/requestApproval')).toBe('current')
  })
  it('classifies legacy flat methods', () => {
    expect(codexApprovalGen('execCommandApproval')).toBe('legacy')
    expect(codexApprovalGen('applyPatchApproval')).toBe('legacy')
  })
  it('returns null for an unrecognized method', () => {
    expect(codexApprovalGen('MysteryApproval')).toBeNull()
  })
})

describe('synthesizeCodexApproval', () => {
  it('maps current + legacy exec/file approvals to canonical tool + input', () => {
    expect(
      synthesizeCodexApproval('item/commandExecution/requestApproval', { command: 'ls -la' }).name
    ).toBe('shell')
    expect(
      synthesizeCodexApproval('execCommandApproval', { command: ['bash', '-lc', 'ls'] }).input
        .command
    ).toBe('bash -lc ls')
    expect(
      synthesizeCodexApproval('item/fileChange/requestApproval', { changes: [{ path: 'a.ts' }] })
        .name
    ).toBe('write')
    expect(
      synthesizeCodexApproval('applyPatchApproval', { fileChanges: { 'a.ts': {} } }).input.file_path
    ).toBe('a.ts')
  })

  it('derives file_path from params.changes (current-gen, session-enriched)', () => {
    const { name, input } = synthesizeCodexApproval('item/fileChange/requestApproval', {
      changes: [{ path: 'src/foo.ts' }]
    })
    expect(name).toBe('write')
    expect(input.file_path).toBe('src/foo.ts')
  })

  it('leaves file_path undefined when no path info is present (current-gen, no enrichment yet)', () => {
    const { input } = synthesizeCodexApproval('item/fileChange/requestApproval', {
      itemId: 'item-2'
    })
    expect(input.file_path).toBeUndefined()
  })

  it('unknown approval method fails closed HIGH ask', () => {
    const { name, input } = synthesizeCodexApproval('MysteryApproval', {})
    expect(name).toBe('codex:MysteryApproval')
    const v = classifyToolCall(name, input, {
      caseDir: 'C:/c',
      workspaceRoots: [],
      readonlyRoots: [],
      taxonomy: CODEX_TOOL_TAXONOMY
    })
    expect(v.action).toBe('ask')
    expect(v.risk).toBe('HIGH')
  })
})

describe('mapCodexDecision', () => {
  it('defaults to current-gen vocabulary', () => {
    expect(mapCodexDecision({ behavior: 'allow', updatedInput: {} })).toEqual({
      decision: 'accept'
    })
  })
  it('maps current-gen allow/deny', () => {
    expect(mapCodexDecision({ behavior: 'allow', updatedInput: {} }, 'current')).toEqual({
      decision: 'accept'
    })
    expect(mapCodexDecision({ behavior: 'deny', message: 'no' }, 'current')).toEqual({
      decision: 'decline'
    })
  })
  it('maps legacy-gen allow/deny', () => {
    expect(mapCodexDecision({ behavior: 'allow', updatedInput: {} }, 'legacy')).toEqual({
      decision: 'approved'
    })
    expect(mapCodexDecision({ behavior: 'deny', message: 'no' }, 'legacy')).toEqual({
      decision: 'denied'
    })
  })
})
