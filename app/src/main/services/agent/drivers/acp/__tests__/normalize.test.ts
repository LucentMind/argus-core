// Fixtures type-derived from @zed…@0.4.5 schema; reconcile against captured JSONL when
// binaries available. No live cursor-agent/grok JSONL exists yet (__fixtures__/{cursor,grok}
// contain only READMEs) — every `update` object below is built to match the real
// `SessionNotification.update` discriminated union documented in
// `../__fixtures__/EVIDENCE.md` (8 variants, discriminator `sessionUpdate`), not a captured
// transcript.
import { describe, it, expect } from 'vitest'
import { createAcpNormalizer } from '../normalize'

const ctx = { caseId: 1, caseSlug: 'NAV-1', sessionId: 7, turnId: 3 }

describe('acp normalize — session/update to AgentEvent', () => {
  it('agent_message_chunk with a text ContentBlock maps to content.delta', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    const out = n.normalize(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      ctx
    )
    expect(out).toEqual([
      expect.objectContaining({ type: 'content.delta', payload: { text: 'hi' } })
    ])
  })

  it('agent_message_chunk with a non-text ContentBlock (image) emits no delta', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    const out = n.normalize(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'base64...', mimeType: 'image/png' }
      },
      ctx
    )
    expect(out).toEqual([])
  })

  it('tool_call maps to tool.call.started with name from title', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    const out = n.normalize(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        kind: 'execute',
        title: 'Run ls',
        status: 'pending'
      },
      ctx
    )
    expect(out).toEqual([
      expect.objectContaining({
        type: 'tool.call.started',
        payload: { toolCallId: 't1', name: 'Run ls' }
      })
    ])
  })

  it('a completed tool_call_update maps to tool.call.completed with isError=false and a readable preview', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    n.normalize(
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run ls', status: 'pending' },
      ctx
    )
    const out = n.normalize(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'file1.txt\nfile2.txt' } }]
      },
      ctx
    )
    expect(out[0]).toEqual(expect.objectContaining({ type: 'tool.call.completed' }))
    const payload = (
      out[0] as {
        payload: { toolCallId: string; name: string; outputPreview: string; isError: boolean }
      }
    ).payload
    expect(payload.toolCallId).toBe('t1')
    expect(payload.name).toBe('Run ls')
    expect(payload.isError).toBe(false)
    expect(payload.outputPreview).toBe('file1.txt\nfile2.txt')
  })

  it('a failed tool_call_update with an object rawOutput (no content blocks) produces a human-readable preview, not "[object Object]"', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    n.normalize(
      { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Run build', status: 'pending' },
      ctx
    )
    const out = n.normalize(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't2',
        status: 'failed',
        rawOutput: { exitCode: 1, stderr: 'build failed: missing dependency' }
      },
      ctx
    )
    expect(out[0]).toEqual(expect.objectContaining({ type: 'tool.call.completed' }))
    const payload = (out[0] as { payload: { outputPreview: string; isError: boolean } }).payload
    expect(payload.isError).toBe(true)
    expect(payload.outputPreview).not.toBe('[object Object]')
    expect(payload.outputPreview).toContain('build failed: missing dependency')
  })

  it('an in_progress tool_call_update is not yet complete — emits nothing', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    const out = n.normalize(
      { sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'in_progress' },
      ctx
    )
    expect(out).toEqual([])
  })

  // --- Intentional no-op variants (must return [], not be silently unhandled) ---

  it('user_message_chunk (echo of user input) is a no-op', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    const out = n.normalize(
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
      ctx
    )
    expect(out).toEqual([])
  })

  it('agent_thought_chunk is a no-op', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    const out = n.normalize(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } },
      ctx
    )
    expect(out).toEqual([])
  })

  it('plan is a no-op here (folded into exit-plan approval in Task 6)', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    const out = n.normalize(
      {
        sessionUpdate: 'plan',
        entries: [{ content: 'do a thing', priority: 'high', status: 'pending' }]
      },
      ctx
    )
    expect(out).toEqual([])
  })

  it('available_commands_update is a no-op', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    const out = n.normalize(
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      ctx
    )
    expect(out).toEqual([])
  })

  it('current_mode_update is a no-op', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    const out = n.normalize({ sessionUpdate: 'current_mode_update', currentModeId: 'default' }, ctx)
    expect(out).toEqual([])
  })

  it('an unrecognized sessionUpdate falls through to the default no-op', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    const out = n.normalize({ sessionUpdate: 'something_new_from_a_future_protocol_version' }, ctx)
    expect(out).toEqual([])
  })

  it('turnResult keeps accounting fields null (costReporting: false) and carries the model', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'composer-1.5' })
    const r = n.turnResult()
    expect(r).toEqual({
      isError: false,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      durationMs: null,
      model: 'composer-1.5',
      authFailure: false
    })
  })

  it('authErrorResult recognizes a typed auth error message', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    const r = n.authErrorResult({ type: 'error', message: 'Unauthorized: invalid API key' })
    expect(r).toEqual(expect.objectContaining({ isError: true, authFailure: true, model: 'auto' }))
  })

  it('authErrorResult returns null for a non-auth error', () => {
    const n = createAcpNormalizer({ resumed: false, model: 'auto' })
    expect(n.authErrorResult({ type: 'error', message: 'disk full' })).toBeNull()
  })
})
