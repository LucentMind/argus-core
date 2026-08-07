import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClaudeDriver } from '../drivers/claude'
import {
  fakeSdk,
  flush,
  canUseToolOf,
  capturingDriver,
  createHarness,
  type SessionHarness
} from './helpers/fakeSdk'

// A session with `unattended: true` has NO renderer attached: nothing can click an approval
// card or answer a Question dialog, and PendingApprovals/PendingDialogs have no timeout. So
// every ask-level verdict must resolve immediately as a deny, on BOTH seams that can reach
// one — `onToolRequest` (the canUseTool path) and `classifyOnly` (the permission-mode
// short-circuit the Copilot/ACP/Codex acceptEdits paths use). Without that, a background
// turn blocks forever; with only one of the two, the other is a bypass.
//
// The interactive counterpart of the canUseTool case ("HIGH round-trips an approval") already
// lives in session.test.ts, so it is not duplicated here; the classifyOnly seam has no such
// existing coverage, so its interactive control IS asserted below.

let h: SessionHarness

beforeEach(() => {
  h = createHarness()
})

afterEach(() => {
  h.cleanup()
})

describe('unattended sessions', () => {
  it('denies every ask-level tool call instead of opening an approval', async () => {
    const sdk = fakeSdk()
    const s = h.makeSession(sdk, { unattended: true })
    s.send('go')
    const canUse = await canUseToolOf(sdk)
    // write_memory classifies MEDIUM/ask (risk.ts NATIVE_RISK); under unattended it must deny.
    const out = await canUse(
      'mcp__argus__write_memory',
      { content: 'x' },
      { signal: new AbortController().signal }
    )
    expect(out.behavior).toBe('deny')
    expect(out.message).toMatch(/unattended/i)
    // No approval card ever opened, and the audit row says denied.
    expect(h.events.some((e) => e.type === 'request.opened')).toBe(false)
    const call = h.db
      .prepare(`SELECT decision, risk FROM tool_calls WHERE tool = 'mcp__argus__write_memory'`)
      .get() as { decision: string; risk: string }
    expect(call).toMatchObject({ decision: 'denied', risk: 'MEDIUM' })
    await s.stop('stopped')
  })

  it('denies a HIGH shell ask too (not just native MEDIUM tools)', async () => {
    const sdk = fakeSdk()
    const s = h.makeSession(sdk, { unattended: true })
    s.send('go')
    const canUse = await canUseToolOf(sdk)
    const out = await canUse(
      'Bash',
      { command: 'git push' },
      { signal: new AbortController().signal }
    )
    expect(out.behavior).toBe('deny')
    expect(out.message).toMatch(/unattended/i)
    expect(h.events.some((e) => e.type === 'request.opened')).toBe(false)
    await s.stop('stopped')
  })

  it('still auto-allows read tools', async () => {
    const sdk = fakeSdk()
    const s = h.makeSession(sdk, { unattended: true })
    s.send('go')
    const canUse = await canUseToolOf(sdk)
    const out = await canUse(
      'mcp__argus__list_evidence',
      {},
      { signal: new AbortController().signal }
    )
    expect(out.behavior).toBe('allow')
    const call = h.db
      .prepare(`SELECT decision FROM tool_calls WHERE tool = 'mcp__argus__list_evidence'`)
      .get() as { decision: string }
    expect(call.decision).toBe('auto')
    await s.stop('stopped')
  })

  it('still enforces deny verdicts with the classifier reason, not the unattended one', async () => {
    const sdk = fakeSdk()
    const s = h.makeSession(sdk, { unattended: true })
    s.send('go')
    const canUse = await canUseToolOf(sdk)
    // A write outside every sandbox root: classified deny, so the classifier's own reason
    // must survive — unattended must not swallow or relabel a real deny.
    const out = await canUse(
      'Write',
      { file_path: '/etc/passwd', content: 'x' },
      { signal: new AbortController().signal }
    )
    expect(out.behavior).toBe('deny')
    expect(out.message).not.toMatch(/unattended/i)
    await s.stop('stopped')
  })

  it('auto-dismisses AskUserQuestion without opening a dialog', async () => {
    const sdk = fakeSdk()
    const s = h.makeSession(sdk, { unattended: true })
    s.send('go')
    const canUse = await canUseToolOf(sdk)
    const out = await canUse(
      'AskUserQuestion',
      { questions: [{ question: 'which?', header: 'h', options: [] }] },
      { signal: new AbortController().signal }
    )
    expect(out.behavior).toBe('allow')
    expect((out.updatedInput as { response?: string }).response).toMatch(/unattended/i)
    expect((out.updatedInput as { answers?: unknown }).answers).toEqual({})
    expect(h.events.some((e) => e.type === 'dialog.opened')).toBe(false)
    const call = h.db
      .prepare(`SELECT decision FROM tool_calls WHERE tool = 'AskUserQuestion'`)
      .get() as { decision: string }
    expect(call.decision).toBe('cancelled')
    await s.stop('stopped')
  })

  // --- the second seam: classifyOnly (permission-mode short-circuits) ------------------
  // Only Copilot/ACP/Codex acceptEdits call this; the Claude driver never does. Reach it
  // through the DriverSessionContext CaseSession handed the driver.

  it('classifyOnly converts an ask verdict to deny under unattended', async () => {
    const sdk = fakeSdk()
    const cap = capturingDriver(createClaudeDriver(sdk.createQuery))
    const s = h.makeSession(sdk, { unattended: true, driver: cap.driver })
    s.send('go')
    await flush()
    const verdict = cap.ctx().classifyOnly!('mcp__argus__write_memory', { content: 'x' })
    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toMatch(/unattended/i)
    const call = h.db
      .prepare(`SELECT decision FROM tool_calls WHERE tool = 'mcp__argus__write_memory'`)
      .get() as { decision: string }
    expect(call.decision).toBe('denied')
    await s.stop('stopped')
  })

  it('classifyOnly is unchanged for an interactive session (ask stays ask)', async () => {
    const sdk = fakeSdk()
    const cap = capturingDriver(createClaudeDriver(sdk.createQuery))
    const s = h.makeSession(sdk, { driver: cap.driver }) // no unattended
    s.send('go')
    await flush()
    const verdict = cap.ctx().classifyOnly!('mcp__argus__write_memory', { content: 'x' })
    expect(verdict.action).toBe('ask')
    const call = h.db
      .prepare(`SELECT decision FROM tool_calls WHERE tool = 'mcp__argus__write_memory'`)
      .get() as { decision: string }
    expect(call.decision).toBe('auto')
    await s.stop('stopped')
  })

  it('classifyOnly still auto-allows LOW tools under unattended', async () => {
    const sdk = fakeSdk()
    const cap = capturingDriver(createClaudeDriver(sdk.createQuery))
    const s = h.makeSession(sdk, { unattended: true, driver: cap.driver })
    s.send('go')
    await flush()
    expect(cap.ctx().classifyOnly!('mcp__argus__list_evidence', {}).action).toBe('allow')
    await s.stop('stopped')
  })

  // --- the mode that would make BOTH seams unreachable ---------------------------------
  // Neither deny seam runs under `bypassPermissions`: the Copilot/ACP/Codex drivers return an
  // approve short-circuit before calling either one, and the Claude SDK skips canUseTool
  // outright. So the session must refuse to run unattended in that mode no matter what the
  // caller passed. Asserted on the options bag the DRIVER received — an internal field would
  // not prove the mode never reached the agent.

  it('never hands the driver a bypassing permission mode when unattended', async () => {
    const sdk = fakeSdk()
    const s = h.makeSession(sdk, {
      unattended: true,
      agentOptions: { permissionMode: 'bypassPermissions' }
    })
    s.send('go')
    await canUseToolOf(sdk) // guarantees the driver installed its options bag
    const opts = sdk.captured.options!
    expect(opts.permissionMode).not.toBe('bypassPermissions')
    // queryOptions.ts omits the field entirely for 'default', and bypassPermissions is inert
    // without this companion flag — so both must be absent.
    expect(opts.permissionMode).toBeUndefined()
    expect(opts.allowDangerouslySkipPermissions).toBeUndefined()
    await s.stop('stopped')
  })

  it('control: an interactive session DOES get bypassPermissions', async () => {
    // Proves the assertion above is load-bearing rather than a fixture that can never produce
    // a bypassing mode, and that the guard is scoped to unattended runs only.
    const sdk = fakeSdk()
    const s = h.makeSession(sdk, { agentOptions: { permissionMode: 'bypassPermissions' } })
    s.send('go')
    await canUseToolOf(sdk)
    expect(sdk.captured.options!.permissionMode).toBe('bypassPermissions')
    expect(sdk.captured.options!.allowDangerouslySkipPermissions).toBe(true)
    await s.stop('stopped')
  })

  it('leaves non-bypassing modes alone under unattended', async () => {
    // acceptEdits reaches classifyOnly, which denies asks under unattended — so it is safe to
    // honour, and the guard must not flatten every mode to default.
    const sdk = fakeSdk()
    const s = h.makeSession(sdk, {
      unattended: true,
      agentOptions: { permissionMode: 'acceptEdits' }
    })
    s.send('go')
    await canUseToolOf(sdk)
    expect(sdk.captured.options!.permissionMode).toBe('acceptEdits')
    expect(sdk.captured.options!.allowDangerouslySkipPermissions).toBeUndefined()
    await s.stop('stopped')
  })
})
