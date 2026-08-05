import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TOOL_FEEDBACK } from '../../agent/nativeTools'
import { PROMPT_ENTRIES, entryById } from '../registry'
import { fillPrompt } from '../fill'
import { applyMemoryWrite, MEMORY_FEEDBACK } from '../../memory'
import { classifyToolCall, RISK_DENY_REASONS, type RiskContext } from '../../agent/risk'

/** Sentinel resolver: proves the value came through `resolve`, not the default. Task 5 reuses it. */
const stub = (id: string): string => `<<${id}>>`

describe('tool-feedback registry entries', () => {
  it('registers one entry per TOOL_FEEDBACK key', () => {
    const ids = PROMPT_ENTRIES.filter(
      (e) => e.category === 'tool-feedback' && e.source.endsWith('nativeTools.ts')
    ).map((e) => e.id)
    expect(ids.sort()).toEqual(
      Object.keys(TOOL_FEEDBACK)
        .map((k) => `tool-feedback.${k}`)
        .sort()
    )
  })

  it('carries the live text and the declared reach', () => {
    const e = entryById('tool-feedback.append_finding.ok')
    expect(e?.default()).toBe(TOOL_FEEDBACK['append_finding.ok'].text)
    expect(e?.reaches).toEqual(['claude-agent-sdk', 'github-copilot'])
    expect(e?.editable).toBe(true)
  })

  it('declares placeholders for every template and none for plain prose', () => {
    expect(entryById('tool-feedback.read_lines.out-of-range')?.placeholders).toEqual([
      'from',
      'total'
    ])
    expect(entryById('tool-feedback.append_finding.ok')?.placeholders).toBeUndefined()
  })

  it('every declared placeholder appears in its own default text', () => {
    for (const [key, spec] of Object.entries(TOOL_FEEDBACK)) {
      for (const p of spec.placeholders ?? []) {
        expect(spec.text, `${key} is missing {${p}}`).toContain(`{${p}}`)
      }
    }
  })

  it('filling a template with no override reproduces the pre-registry message', () => {
    const text = fillPrompt(TOOL_FEEDBACK['read_lines.out-of-range'].text, {
      from: '900',
      total: '120'
    })
    expect(text).toBe('line 900 does not exist — the file ends at line 120')
  })
})

describe('memory write errors honour an injected resolver', () => {
  const home = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mem-fb-'))

  it('registers one entry per MEMORY_FEEDBACK key', () => {
    const ids = PROMPT_ENTRIES.filter(
      (e) => e.category === 'tool-feedback' && e.source.endsWith('services/memory.ts')
    ).map((e) => e.id)
    expect(ids.sort()).toEqual(
      Object.keys(MEMORY_FEEDBACK)
        .map((k) => `tool-feedback.${k}`)
        .sort()
    )
  })

  it('throws the resolved text when a resolver is supplied', () => {
    expect(() =>
      applyMemoryWrite(
        home(),
        'c-1',
        { topic: 'anything', content: '   ', scope: 'preference' },
        stub
      )
    ).toThrow('<<tool-feedback.write_memory.empty-content>>')
  })

  it('throws the default text when no resolver is supplied', () => {
    expect(() =>
      applyMemoryWrite(home(), 'c-1', { topic: 'anything', content: '   ', scope: 'preference' })
    ).toThrow('write_memory: content must not be empty')
  })

  it('fills the index-entry length cap from the same constant the check uses', () => {
    expect(() =>
      applyMemoryWrite(home(), 'c-1', {
        topic: 'anything',
        content: 'body',
        scope: 'preference',
        indexEntry: 'x'.repeat(201)
      })
    ).toThrow('at most 200 characters')
  })

  it('registers the two new scope-rejection keys', () => {
    expect(entryById('tool-feedback.write_memory.missing-scope')).toBeTruthy()
    expect(entryById('tool-feedback.write_memory.invalid-scope')).toBeTruthy()
  })

  it('the invalid-scope message is filled with the offending value', () => {
    expect(() =>
      applyMemoryWrite(home(), 'c-1', { topic: 'anything', content: 'x', scope: 'workflow' })
    ).toThrow('"workflow" is not a valid scope')
  })
})

describe('sandbox deny reasons honour an injected resolver', () => {
  // `inSandbox` = caseDir + workspaceRoots + readonlyRoots (risk.ts:141), so a path under a
  // read-only root IS in the sandbox and reaches the read-only check rather than being denied
  // as out-of-sandbox first. Bash needs a shell taxonomy entry or it fails closed before the
  // classifier runs.
  const baseCtx = (resolve?: (id: string) => string): RiskContext => ({
    caseDir: '/cases/c-1',
    workspaceRoots: [],
    readonlyRoots: ['/skills'],
    taxonomy: {
      entries: {
        Write: { kind: 'fs-write', pathFields: ['file_path'] },
        Bash: { kind: 'shell', commandField: 'command' }
      }
    },
    ...(resolve ? { resolve } : {})
  })

  it('registers one entry per RISK_DENY_REASONS key', () => {
    const ids = PROMPT_ENTRIES.filter(
      (e) => e.category === 'tool-feedback' && e.source.endsWith('agent/risk.ts')
    ).map((e) => e.id)
    expect(ids.sort()).toEqual(
      Object.keys(RISK_DENY_REASONS)
        .map((k) => `tool-feedback.${k}`)
        .sort()
    )
  })

  it('an out-of-sandbox write denies with the resolved reason', () => {
    const v = classifyToolCall('Write', { file_path: '/etc/passwd' }, baseCtx(stub))
    expect(v.action).toBe('deny')
    expect(v.action === 'deny' && v.reason).toBe('<<tool-feedback.risk.path-outside-sandbox>>')
  })

  it('a read-only-root write denies with the resolved reason', () => {
    const v = classifyToolCall('Write', { file_path: '/skills/x.md' }, baseCtx(stub))
    expect(v.action).toBe('deny')
    expect(v.action === 'deny' && v.reason).toBe('<<tool-feedback.risk.readonly-root>>')
  })

  it('with no resolver the reason is the filled default, path included', () => {
    const v = classifyToolCall('Write', { file_path: '/etc/passwd' }, baseCtx())
    expect(v.action === 'deny' && v.reason).toBe('Path outside sandbox: /etc/passwd')
  })

  it('ask reasons are NOT resolved — they are approval-card copy, not model-facing', () => {
    const v = classifyToolCall('Bash', { command: 'rm -rf /tmp/x' }, baseCtx(stub))
    expect(v.action).toBe('ask')
    expect(v.action === 'ask' && v.reason).toBe('Recursive delete')
  })
})
