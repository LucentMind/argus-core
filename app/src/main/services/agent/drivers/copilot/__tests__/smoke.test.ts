import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCopilotDriver } from '../index'
import type { AgentEvent } from '../../../../../../shared/agent-events'
import type { DriverSessionContext, TurnResult } from '../../../driver'
import type { NativeToolDeps } from '../../../nativeTools'

/**
 * Real-runtime smoke test. Gated behind COPILOT_SMOKE so committed CI never boots the
 * bundled Copilot runtime or requires auth. Run manually with:
 *   COPILOT_SMOKE=1 npx vitest run src/main/services/agent/drivers/copilot/__tests__/smoke.test.ts
 * It uses a throwaway scratch baseDirectory (never ~/.copilot / gh auth) and a tiny prompt.
 */
describe.skipIf(!process.env.COPILOT_SMOKE)('copilot driver — real runtime smoke', () => {
  it('probes auth and runs one tiny turn against the bundled runtime', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-smoke-'))
    const caseDir = path.join(scratch, 'case')
    fs.mkdirSync(caseDir, { recursive: true })
    const driver = createCopilotDriver()

    // 1) turn-free auth probe
    const auth = await driver.probeAuth({ timeoutMs: 20000 })
    console.log('[SMOKE] probeAuth:', JSON.stringify(auth))
    expect(auth.ok).toBe(true)

    // 2) one tiny turn
    const ctx: DriverSessionContext = {
      caseDir,
      additionalDirectories: [],
      permissionMode: 'default',
      systemAppend: '',
      extraMcpServers: {},
      nativeToolDeps: { argusHome: scratch } as unknown as NativeToolDeps,
      panelCommandDecls: [],
      resumeCursor: null,
      eventCtx: () => ({ caseId: 1, caseSlug: 'smoke', sessionId: 1, turnId: 1 }),
      onToolRequest: async () => ({ behavior: 'deny', message: 'no tools in smoke' }),
      onCursor: (c) => console.log('[SMOKE] cursor:', c),
      onTurnResult: (r: TurnResult) => console.log('[SMOKE] turnResult:', JSON.stringify(r))
    }
    const session = driver.createSession(ctx)
    const events: AgentEvent[] = []
    const drained = (async () => {
      for await (const e of session.events()) {
        events.push(e)
        if (e.type === 'turn.completed') session.end()
      }
    })()
    session.send('Reply with exactly: OK')
    await drained

    const text = events
      .filter((e) => e.type === 'assistant.message')
      .map((e) => (e.type === 'assistant.message' ? e.payload.text : ''))
      .join('')
    console.log('[SMOKE] assistant text:', JSON.stringify(text))
    console.log('[SMOKE] event types:', events.map((e) => e.type).join(','))
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true)
    expect(text.length).toBeGreaterThan(0)

    // Best-effort scratch cleanup: the runtime may still hold COPILOT_HOME briefly after
    // stop(), so an EBUSY here is not a test failure.
    try {
      fs.rmSync(scratch, { recursive: true, force: true })
    } catch {
      /* leave the throwaway dir for the OS temp reaper */
    }
  }, 60000)
})
