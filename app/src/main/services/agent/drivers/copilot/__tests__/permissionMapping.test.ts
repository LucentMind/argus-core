import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../../../db'
import { createDetection } from '../../../../packs/detection'
import {
  createCopilotDriver,
  synthesizePermissionRequest,
  buildCopilotTools,
  exitPlanModeDecision,
  mapToolDecision
} from '../index'
import type {
  CopilotClientFactory,
  CopilotClientLike,
  CopilotSessionConfig,
  CopilotSessionLike
} from '../client'
import type { DriverSessionContext, ToolDecision } from '../../../driver'
import type { NativeToolDeps } from '../../../nativeTools'
import type { AgentEvent } from '../../../../../../shared/agent-events'
import type { PanelCommandDecl } from '../../../panelCommands'
import { classifyToolCall } from '../../../risk'
import { COPILOT_TOOL_TAXONOMY } from '../taxonomy'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__')
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

/** Pull the raw SDK `PermissionRequest` objects from a captured fixture's
 *  `kind:"permission-request"` envelopes (`data.request`). */
function permissionRequests(fixture: string): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(FIXTURES, fixture), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((o) => o.kind === 'permission-request')
    .map((o) => o.data.request as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Pure synthesis: one typed PermissionRequest → canonical (name, input)
// ---------------------------------------------------------------------------
describe('synthesizePermissionRequest — per-kind name + input (fixtures 02/03/04/05)', () => {
  it('02 write → name "write", input {file_path, diff}', () => {
    const [req] = permissionRequests('02-write-permission.jsonl')
    const s = synthesizePermissionRequest(req)
    expect(s.name).toBe('write')
    expect(s.input.file_path).toBe(req.fileName)
    expect(s.input.diff).toBe(req.diff)
  })

  it('03 shell → name "shell", input.command = fullCommandText + pre-parsed metadata', () => {
    const [req] = permissionRequests('03-shell-permission.jsonl')
    const s = synthesizePermissionRequest(req)
    expect(s.name).toBe('shell')
    expect(s.input.command).toBe('echo hi')
    expect(s.input.command).toBe(req.fullCommandText)
    // Pre-parsed fields are carried for an informative approval card (not for risk logic).
    expect(s.input).toHaveProperty('commands')
    expect(s.input).toHaveProperty('hasWriteFileRedirection', false)
  })

  it('04 read → name "read" {file_path}, and url → name "fetch" {url}', () => {
    const reqs = permissionRequests('04-read-fetch.jsonl')
    const read = reqs.find((r) => r.kind === 'read')!
    const url = reqs.find((r) => r.kind === 'url')!
    expect(synthesizePermissionRequest(read)).toEqual({
      name: 'read',
      input: { file_path: read.path }
    })
    expect(synthesizePermissionRequest(url)).toEqual({ name: 'fetch', input: { url: url.url } })
  })

  it('05 custom-tool argus_* → canonical mcp__argus__* with args (prefix rule)', () => {
    const [req] = permissionRequests('05-custom-tool.jsonl')
    const s = synthesizePermissionRequest(req)
    expect(s.name).toBe('mcp__argus__echo') // argus_echo → mcp__argus__echo
    expect(s.input).toEqual({ text: 'hello-argus' })
  })

  it('custom-tool uses the toolNameMap when present (panel + native)', () => {
    const map = new Map([['panel_myPack_win_do', 'mcp__myPack__win_do']])
    expect(
      synthesizePermissionRequest(
        { kind: 'custom-tool', toolName: 'panel_myPack_win_do', args: {} },
        map
      ).name
    ).toBe('mcp__myPack__win_do')
    // Unknown custom tool with no argus_ prefix → raw name (fail-closed via empty taxonomy).
    expect(
      synthesizePermissionRequest({ kind: 'custom-tool', toolName: 'weird_thing', args: {} }).name
    ).toBe('weird_thing')
  })

  it('mcp kind → mcp__<server>__<tool> with args', () => {
    const s = synthesizePermissionRequest({
      kind: 'mcp',
      serverName: 'atlassian',
      toolName: 'getJiraIssue',
      args: { key: 'X-1' }
    })
    expect(s).toEqual({ name: 'mcp__atlassian__getJiraIssue', input: { key: 'X-1' } })
  })

  it.each(['memory', 'hook', 'extension-management', 'extension-permission-access', 'mystery'])(
    'unmapped kind %s → copilot:<kind> (fails closed HIGH)',
    (kind) => {
      const s = synthesizePermissionRequest({ kind, fact: 'x' })
      expect(s.name).toBe(`copilot:${kind}`)
    }
  )
})

describe('mapToolDecision', () => {
  it('allow → approve-once; deny → reject with feedback', () => {
    expect(mapToolDecision({ behavior: 'allow', updatedInput: {} })).toEqual({
      kind: 'approve-once'
    })
    expect(mapToolDecision({ behavior: 'deny', message: 'nope' })).toEqual({
      kind: 'reject',
      feedback: 'nope'
    })
  })
})

describe('exitPlanModeDecision — routes the plan through the approval pipeline', () => {
  const signal = new AbortController().signal
  const req = {
    summary: 'plan summary',
    planContent: '# Plan\n1. do it',
    actions: ['autopilot', 'exit_only'],
    recommendedAction: 'autopilot'
  }

  it('synthesizes copilot:exit-plan with the plan content and asks onToolRequest', async () => {
    const onToolRequest = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }))
    const res = await exitPlanModeDecision(req, onToolRequest, signal)
    expect(onToolRequest).toHaveBeenCalledTimes(1)
    expect(onToolRequest.mock.calls[0][0]).toBe('copilot:exit-plan')
    expect(onToolRequest.mock.calls[0][1]).toEqual({
      summary: 'plan summary',
      planContent: '# Plan\n1. do it',
      actions: ['autopilot', 'exit_only'],
      recommendedAction: 'autopilot'
    })
    // allow → leave plan mode into the runtime's recommended action.
    expect(res).toEqual({ approved: true, selectedAction: 'autopilot' })
  })

  it('deny → approved:false with the deny feedback (model keeps planning)', async () => {
    const onToolRequest = vi.fn(async () => ({
      behavior: 'deny' as const,
      message: 'revise the plan first'
    }))
    expect(await exitPlanModeDecision(req, onToolRequest, signal)).toEqual({
      approved: false,
      feedback: 'revise the plan first'
    })
  })

  it('allow with no recommendedAction → approved without selectedAction', async () => {
    const onToolRequest = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }))
    expect(await exitPlanModeDecision({}, onToolRequest, signal)).toEqual({ approved: true })
  })
})

// ---------------------------------------------------------------------------
// Native + panel tool binding (SessionConfig.tools)
// ---------------------------------------------------------------------------
describe('buildCopilotTools', () => {
  let tmp: string, db: DatabaseSync
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-tools-'))
    db = openDb(path.join(tmp, 'argus.db'))
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const nativeDeps = (): NativeToolDeps => ({
    db,
    argusHome: tmp,
    detection: createDetection(),
    caseId: 1,
    caseSlug: 'c',
    sessionId: 1,
    emitFinding: () => {}
  })

  const panelDecls: PanelCommandDecl[] = [
    { packId: 'log', windowId: 'viewer', cmd: 'open', risk: 'low', args: ['path'] },
    { packId: 'log', windowId: 'viewer', cmd: 'purge', risk: 'high', args: [] }
  ]

  const ctx = (over: Partial<DriverSessionContext> = {}): DriverSessionContext =>
    ({
      caseDir: tmp,
      additionalDirectories: [],
      permissionMode: 'default',
      systemAppend: '',
      extraMcpServers: {},
      nativeToolDeps: nativeDeps(),
      panelCommandDecls: [],
      resumeCursor: null,
      eventCtx: () => ({ caseId: 1, caseSlug: 'c', sessionId: 1, turnId: 1 }),
      onToolRequest: async () => ({ behavior: 'allow', updatedInput: {} }),
      onCursor: () => {},
      onTurnResult: () => {},
      ...over
    }) as DriverSessionContext

  it('registers every native spec as argus_<name> with a canonical map entry', () => {
    const map = new Map<string, string>()
    const tools = buildCopilotTools(ctx(), map)
    expect(tools.find((t) => t.name === 'argus_append_finding')).toBeTruthy()
    expect(map.get('argus_append_finding')).toBe('mcp__argus__append_finding')
    // Every tool has a Zod schema (has toJSONSchema) and a handler.
    for (const t of tools) {
      expect(typeof t.handler).toBe('function')
      expect(typeof (t.parameters as { toJSONSchema?: unknown }).toJSONSchema).toBe('function')
    }
  })

  it('sets skipPermission per NATIVE_RISK: LOW auto-allow bypasses, MEDIUM/HIGH stays gated', () => {
    const tools = buildCopilotTools(ctx(), new Map())
    const skip = (n: string): boolean | undefined => tools.find((t) => t.name === n)?.skipPermission
    expect(skip('argus_append_finding')).toBe(true) // LOW → bypass
    expect(skip('argus_search_evidence')).toBe(true) // LOW → bypass
    expect(skip('argus_write_memory')).toBe(false) // MEDIUM → gated
    expect(skip('argus_update_case_status')).toBe(false) // MEDIUM → gated
    expect(skip('argus_workspace_checkout')).toBe(false) // MEDIUM → gated
  })

  it('registers panel commands as panel_<pack>_<window>_<cmd> → canonical mcp name, risk-gated', () => {
    const dispatch = vi.fn(async () => ({ ok: true }))
    const map = new Map<string, string>()
    const tools = buildCopilotTools(
      ctx({ panelCommandDecls: panelDecls, dispatchPanelCommand: dispatch }),
      map
    )
    const open = tools.find((t) => t.name === 'panel_log_viewer_open')!
    const purge = tools.find((t) => t.name === 'panel_log_viewer_purge')!
    expect(open.skipPermission).toBe(true) // low
    expect(purge.skipPermission).toBe(false) // high
    expect(map.get('panel_log_viewer_open')).toBe('mcp__log__viewer_open')
  })

  it('panel handler round-trips through dispatchPanelCommand with positional args', async () => {
    const dispatch = vi.fn(async () => ({ opened: true }))
    const tools = buildCopilotTools(
      ctx({ panelCommandDecls: panelDecls, dispatchPanelCommand: dispatch }),
      new Map()
    )
    const open = tools.find((t) => t.name === 'panel_log_viewer_open')!
    const out = await open.handler({ path: '/x/y.log' })
    expect(dispatch).toHaveBeenCalledWith('log', 'viewer', 'open', ['/x/y.log'])
    expect(JSON.parse(out as string)).toEqual({ opened: true })
  })

  it('native handler round-trips (list_evidence returns JSON)', async () => {
    const tools = buildCopilotTools(ctx(), new Map())
    const list = tools.find((t) => t.name === 'argus_list_evidence')!
    const out = await list.handler({})
    expect(Array.isArray(JSON.parse(out as string))).toBe(true) // empty case → []
  })

  it('omits panel tools when no dispatchPanelCommand is provided', () => {
    const tools = buildCopilotTools(ctx({ panelCommandDecls: panelDecls }), new Map())
    expect(tools.some((t) => t.name.startsWith('panel_'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Full handler path through a captured session config
// ---------------------------------------------------------------------------
type Perm = NonNullable<CopilotSessionConfig['onPermissionRequest']>

function captureFactory(): {
  factory: CopilotClientFactory
  getConfig: () => CopilotSessionConfig | null
  modeSet: ReturnType<typeof vi.fn>
} {
  let config: CopilotSessionConfig | null = null
  const modeSet = vi.fn(async () => undefined)
  const factory: CopilotClientFactory = () => {
    const session: CopilotSessionLike = {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      on: () => () => {},
      send: async () => 'ok',
      abort: async () => {},
      rpc: { mode: { set: modeSet } }
    }
    const client: CopilotClientLike = {
      start: async () => {},
      createSession: async (c) => {
        config = c
        return session
      },
      resumeSession: async (_id, c) => {
        config = c
        return session
      },
      getAuthStatus: async () => ({ isAuthenticated: true }),
      getStatus: async () => ({ version: '1' }),
      stop: async () => [],
      forceStop: async () => {}
    }
    return client
  }
  return { factory, getConfig: () => config, modeSet }
}

function baseCtx(over: Partial<DriverSessionContext> = {}): DriverSessionContext {
  return {
    caseDir: '/tmp/case',
    additionalDirectories: [],
    permissionMode: 'default',
    systemAppend: '',
    extraMcpServers: {},
    nativeToolDeps: { argusHome: '/tmp/h', caseSlug: 'c' } as unknown as NativeToolDeps,
    panelCommandDecls: [],
    resumeCursor: null,
    eventCtx: () => ({ caseId: 1, caseSlug: 'c', sessionId: 1, turnId: 1 }),
    onToolRequest: async () => ({ behavior: 'allow', updatedInput: {} }),
    onCursor: vi.fn(),
    onTurnResult: vi.fn(),
    ...over
  }
}

describe('permission handler — decision round-trips via captured config', () => {
  it('allow → approve-once with the synthesized name/input (04 read)', async () => {
    const { factory, getConfig } = captureFactory()
    const onToolRequest = vi.fn<(n: string, i: Record<string, unknown>) => Promise<ToolDecision>>(
      async () => ({ behavior: 'allow', updatedInput: {} })
    )
    createCopilotDriver({}, { clientFactory: factory }).createSession(baseCtx({ onToolRequest }))
    await tick()
    const handler = getConfig()!.onPermissionRequest as Perm
    const read = permissionRequests('04-read-fetch.jsonl').find((r) => r.kind === 'read')!
    const decision = await handler(read, { sessionId: 's' })
    expect(decision).toEqual({ kind: 'approve-once' })
    expect(onToolRequest).toHaveBeenCalledTimes(1)
    expect(onToolRequest.mock.calls[0][0]).toBe('read')
    expect(onToolRequest.mock.calls[0][1]).toEqual({ file_path: read.path })
  })

  it('deny → reject{feedback} (04 captured url deny)', async () => {
    const { factory, getConfig } = captureFactory()
    const onToolRequest = vi.fn<(n: string, i: Record<string, unknown>) => Promise<ToolDecision>>(
      async () => ({ behavior: 'deny', message: 'no egress' })
    )
    createCopilotDriver({}, { clientFactory: factory }).createSession(baseCtx({ onToolRequest }))
    await tick()
    const handler = getConfig()!.onPermissionRequest as Perm
    const url = permissionRequests('04-read-fetch.jsonl').find((r) => r.kind === 'url')!
    const decision = await handler(url, { sessionId: 's' })
    expect(decision).toEqual({ kind: 'reject', feedback: 'no egress' })
    expect(onToolRequest.mock.calls[0][0]).toBe('fetch')
  })

  it('acceptEdits auto-approves write WITHOUT consulting onToolRequest; still asks for read', async () => {
    const { factory, getConfig } = captureFactory()
    const onToolRequest = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }))
    createCopilotDriver({}, { clientFactory: factory }).createSession(
      baseCtx({ permissionMode: 'acceptEdits', onToolRequest })
    )
    await tick()
    const handler = getConfig()!.onPermissionRequest as Perm
    const write = permissionRequests('02-write-permission.jsonl')[0]
    expect(await handler(write, { sessionId: 's' })).toEqual({ kind: 'approve-once' })
    expect(onToolRequest).not.toHaveBeenCalled() // short-circuited, mirrors Claude SDK

    const read = permissionRequests('04-read-fetch.jsonl').find((r) => r.kind === 'read')!
    await handler(read, { sessionId: 's' })
    expect(onToolRequest).toHaveBeenCalledTimes(1) // read is NOT auto-approved
  })

  it('bypassPermissions approves everything WITHOUT consulting onToolRequest', async () => {
    const { factory, getConfig } = captureFactory()
    const onToolRequest = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }))
    createCopilotDriver({}, { clientFactory: factory }).createSession(
      baseCtx({ permissionMode: 'bypassPermissions', onToolRequest })
    )
    await tick()
    const handler = getConfig()!.onPermissionRequest as Perm
    const shell = permissionRequests('03-shell-permission.jsonl')[0]
    expect(await handler(shell, { sessionId: 's' })).toEqual({ kind: 'approve-once' })
    expect(onToolRequest).not.toHaveBeenCalled()
  })

  it('plan mode calls session.rpc.mode.set({mode:"plan"}) after creation', async () => {
    const { factory, modeSet } = captureFactory()
    createCopilotDriver({}, { clientFactory: factory }).createSession(
      baseCtx({ permissionMode: 'plan' })
    )
    await tick()
    expect(modeSet).toHaveBeenCalledWith({ mode: 'plan' })
  })

  it('default mode does NOT touch mode.set', async () => {
    const { factory, modeSet } = captureFactory()
    createCopilotDriver({}, { clientFactory: factory }).createSession(baseCtx())
    await tick()
    expect(modeSet).not.toHaveBeenCalled()
  })

  it('installs the native tools + exit-plan handler on the session config', async () => {
    const { factory, getConfig } = captureFactory()
    createCopilotDriver({}, { clientFactory: factory }).createSession(baseCtx())
    await tick()
    const cfg = getConfig()!
    expect(cfg.tools?.some((t) => t.name === 'argus_append_finding')).toBe(true)
    expect(typeof cfg.onExitPlanModeRequest).toBe('function')
  })
})

describe('acceptEdits honors deny verdicts via classifyOnly (never approves an unsafe write)', () => {
  // A realistic classifyOnly: the harness runs the SAME risk classifier the ask path uses,
  // with no approval card. Wires the Copilot taxonomy + a caseDir/readonlyRoots sandbox.
  const classifyOnlyFor =
    (caseDir: string, readonlyRoots: string[] = []) =>
    (toolName: string, input: Record<string, unknown>) => {
      const v = classifyToolCall(toolName, input, {
        caseDir,
        workspaceRoots: [],
        readonlyRoots,
        taxonomy: COPILOT_TOOL_TAXONOMY
      })
      return { action: v.action, ...('reason' in v ? { reason: v.reason } : {}) }
    }

  const writeReq = (fileName: string): Record<string, unknown> => ({
    kind: 'write',
    fileName,
    diff: '@@ -0,0 +1 @@\n+hi'
  })

  async function handlerWith(
    over: Partial<DriverSessionContext>
  ): Promise<{ handler: Perm; onToolRequest: ReturnType<typeof vi.fn> }> {
    const { factory, getConfig } = captureFactory()
    const onToolRequest = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }))
    createCopilotDriver({}, { clientFactory: factory }).createSession(
      baseCtx({ permissionMode: 'acceptEdits', onToolRequest, ...over })
    )
    await tick()
    return { handler: getConfig()!.onPermissionRequest as Perm, onToolRequest }
  }

  it('rejects a write to an out-of-sandbox absolute path', async () => {
    const { handler, onToolRequest } = await handlerWith({
      caseDir: '/tmp/case',
      classifyOnly: classifyOnlyFor('/tmp/case')
    })
    const decision = await handler(writeReq('/etc/passwd'), { sessionId: 's' })
    expect(decision.kind).toBe('reject')
    expect((decision as { feedback: string }).feedback.toLowerCase()).toContain('outside sandbox')
    expect(onToolRequest).not.toHaveBeenCalled() // classifyOnly does not open a card
  })

  it('rejects a write into a read-only root', async () => {
    const { handler } = await handlerWith({
      caseDir: '/tmp/case',
      classifyOnly: classifyOnlyFor('/tmp/case', ['/tmp/case/skills'])
    })
    const decision = await handler(writeReq('/tmp/case/skills/evil.md'), { sessionId: 's' })
    expect(decision.kind).toBe('reject')
    expect((decision as { feedback: string }).feedback.toLowerCase()).toContain('read-only')
  })

  it('approves an in-sandbox write WITHOUT opening an approval card', async () => {
    const { handler, onToolRequest } = await handlerWith({
      caseDir: '/tmp/case',
      classifyOnly: classifyOnlyFor('/tmp/case')
    })
    const decision = await handler(writeReq('/tmp/case/notes.txt'), { sessionId: 's' })
    expect(decision).toEqual({ kind: 'approve-once' })
    expect(onToolRequest).not.toHaveBeenCalled() // ask suppressed by acceptEdits
  })
})

describe('mcpConnectors:false degradation — session.mcp.skipped', () => {
  it('emits one session.mcp.skipped per composed connector at session start', async () => {
    const { factory } = captureFactory()
    const session = createCopilotDriver({}, { clientFactory: factory }).createSession(
      baseCtx({ extraMcpServers: { atlassian: {}, github: {} } })
    )
    const seen: AgentEvent[] = []
    const drained = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()
    await tick()
    session.end()
    await drained
    const skips = seen.filter((e) => e.type === 'session.mcp.skipped')
    expect(
      skips.map((s) => s.type === 'session.mcp.skipped' && s.payload.instanceId).sort()
    ).toEqual(['atlassian', 'github'])
    for (const s of skips) {
      if (s.type === 'session.mcp.skipped') expect(s.payload.reason).toBe('copilot-driver-no-mcp')
    }
  })
})
