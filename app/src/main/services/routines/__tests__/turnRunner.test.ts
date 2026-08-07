import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { applyMemoryWrite } from '../../memory'
import { createSession } from '../../agent/sessionStore'
import { createDetection } from '../../packs/detection'
import { createClaudeDriver } from '../../agent/drivers/claude'
import {
  fakeSdk,
  flush,
  canUseToolOf,
  capturingDriver
} from '../../agent/__tests__/helpers/fakeSdk'
import { NEUTRAL_PERSONA } from '../../agent/persona'
import { createRoutineTurnRunner, type RoutineTurnRunnerDeps } from '../turnRunner'
import { RoutineStore } from '../store'
import { RoutinesService } from '../service'
import { listRoutineRuns } from '../runs'
import { agentAccessSchema, defaultAgentAccess } from '../../../../shared/agentAccess'
import type { AgentDriver, DriverSessionContext } from '../../agent/driver'
import type { RoutineTurnRequest } from '../service'

/**
 * The production binding of `RoutinesService.runTurn`.
 *
 * This is the seam the whole-branch review found empty: a background session was constructed
 * with none of the session-shape deps an interactive one gets, and the driver kind it recorded
 * was not the driver it ran on. Both used to live in an inline closure in `main/index.ts`,
 * which imports electron at module scope and is therefore unreachable from any runtime test —
 * so neither defect could go red anywhere. Extracting `turnRunner.ts` is what makes these
 * assertions possible at all.
 */

const RESULT_SUCCESS = {
  type: 'result',
  subtype: 'success',
  session_id: '11111111-1111-4111-8111-111111111111',
  usage: { input_tokens: 5, output_tokens: 2 },
  total_cost_usd: 0.001,
  duration_ms: 10,
  is_error: false
}

let tmp: string, argusHome: string, db: DatabaseSync
let caseId: number, sessionId: number

const SLUG = 'routine-x'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rtr-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  caseId = createCase(db, argusHome, { slug: SLUG, title: 'Routine: x' }).id
  sessionId = createSession(db, SLUG, 'claude-agent-sdk').id
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A shared skill on disk, so materializeSessionSkills has something real to resolve. */
function writeSkill(name: string, description: string): void {
  const dir = path.join(argusHome, 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`
  )
}

function request(over: Partial<RoutineTurnRequest> = {}): RoutineTurnRequest {
  return {
    caseId,
    caseSlug: SLUG,
    sessionId,
    driverKind: 'claude-agent-sdk',
    prompt: 'sweep',
    timeoutMs: 5000,
    ...over
  }
}

function runnerDeps(
  driver: AgentDriver,
  over: Partial<RoutineTurnRunnerDeps> = {}
): RoutineTurnRunnerDeps {
  return {
    db,
    argusHome,
    detection: createDetection(),
    skillsRoots: [],
    driverFor: () => driver,
    agentAccess: () => defaultAgentAccess(),
    ...over
  }
}

describe('createRoutineTurnRunner — driver-kind mismatch is fatal (review fix 2)', () => {
  it('throws instead of silently running on the fallback driver', () => {
    const sdk = fakeSdk()
    // Exactly what getDriverByKind does for an unregistered kind: hand back Claude.
    const claude = createClaudeDriver(sdk.createQuery)
    const run = createRoutineTurnRunner(runnerDeps(claude))
    expect(() => run(request({ driverKind: 'coplilot' }))).toThrow(/coplilot/)
    // Nothing was started: no query was constructed, so no turn ran on the wrong provider.
    expect(sdk.captured.options).toBeUndefined()
  })

  it('lets the matching kind through', async () => {
    const sdk = fakeSdk()
    const run = createRoutineTurnRunner(runnerDeps(createClaudeDriver(sdk.createQuery)))
    const p = run(request())
    await flush()
    sdk.messages.push(RESULT_SUCCESS)
    await expect(p).resolves.toMatchObject({ status: 'ok' })
  })

  it('RoutinesService turns that throw into a failed run the UI can render', async () => {
    // The claim the fix rests on, verified against the real `execute` rather than assumed:
    // the throw happens inside `await this.deps.runTurn(...)`, which sits in execute's
    // try/catch, so it lands in the run row's `error` — the field the run-history UI already
    // shows — instead of escaping as an unhandled rejection or a console-only warning.
    const store = new RoutineStore(argusHome)
    store.upsert({ id: 'x', name: 'X', prompt: 'sweep', driverKind: 'coplilot', timeoutMs: 1000 })
    const sdk = fakeSdk()
    const svc = new RoutinesService({
      db,
      argusHome,
      store,
      runTurn: createRoutineTurnRunner(runnerDeps(createClaudeDriver(sdk.createQuery)))
    })
    svc.startRun('x')
    await svc.whenIdle()
    store.close()

    const [run] = listRoutineRuns(db)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/coplilot/)
    // The user-visible reason names BOTH kinds — the one recorded and the one that would have
    // executed — because "unknown driver kind" alone does not say what nearly happened.
    expect(run.error).toMatch(/claude-agent-sdk/)
    expect(listRoutineRuns(db).filter((r) => r.status === 'running')).toEqual([])
  })
})

describe('createRoutineTurnRunner — session-shape deps (review fix 1)', () => {
  /** Run one turn and hand back the DriverSessionContext the session actually built. */
  async function contextOf(over: Partial<RoutineTurnRunnerDeps> = {}): Promise<{
    ctx: DriverSessionContext
    finish: () => Promise<unknown>
    sdk: ReturnType<typeof fakeSdk>
  }> {
    const sdk = fakeSdk()
    const cap = capturingDriver(createClaudeDriver(sdk.createQuery))
    const run = createRoutineTurnRunner(runnerDeps(cap.driver, over))
    const p = run(request())
    await flush()
    return {
      ctx: cap.ctx(),
      sdk,
      finish: () => {
        sdk.messages.push(RESULT_SUCCESS)
        return p
      }
    }
  }

  it('gives the run the enabled skills AND advertises them', async () => {
    writeSkill('analyze-applog', 'Read an application log')
    const { ctx, finish } = await contextOf()
    // Without `enabledSkills`, session.ts passes `skills: []` — a routine with zero Argus skills.
    expect(ctx.skills).toContain('analyze-applog')
    // Without `skillIndex` the skill is loadable but the model is never told it exists, which
    // makes passing the allowlist pointless. Both halves or neither.
    expect(ctx.systemAppend).toContain('analyze-applog: Read an application log')
    await finish()
  })

  it('honours a skill the user disabled on the Knowledge page', async () => {
    writeSkill('analyze-applog', 'Read an application log')
    writeSkill('other-skill', 'Something else')
    const access = agentAccessSchema.parse({ skills: { 'bundled/analyze-applog': false } })
    const { ctx, finish } = await contextOf({ agentAccess: () => access })
    expect(ctx.skills).not.toContain('analyze-applog')
    expect(ctx.skills).toContain('other-skill')
    await finish()
  })

  it('does NOT inject a memory topic the user disabled — the privacy defect', async () => {
    // THE defect this whole group exists for. Without `agentAccess`, session.ts falls back to
    // `defaultAgentAccess()`, which treats every topic as enabled — so a topic the user
    // explicitly switched off on the Knowledge page was injected into unattended runs anyway,
    // silently bypassing a user-facing privacy control in the one place no window is watching.
    applyMemoryWrite(argusHome, SLUG, {
      topic: 'secret-topic',
      content: 'do not share this',
      scope: 'preference',
      indexEntry: 'a lesson the user hid'
    })
    applyMemoryWrite(argusHome, SLUG, {
      topic: 'public-topic',
      content: 'fine to use',
      scope: 'preference',
      indexEntry: 'a lesson the user kept'
    })

    // Positive control first: with nothing disabled, BOTH topics reach the prompt. Without this
    // the negative assertion below could pass simply because no memory index is built at all.
    const open = await contextOf()
    expect(open.ctx.systemAppend).toContain('secret-topic.md')
    expect(open.ctx.systemAppend).toContain('public-topic.md')
    await open.finish()

    const access = agentAccessSchema.parse({ memory: { 'secret-topic': false } })
    const closed = await contextOf({ agentAccess: () => access })
    expect(closed.ctx.systemAppend).not.toContain('secret-topic.md')
    expect(closed.ctx.systemAppend).not.toContain('a lesson the user hid')
    // The topics the user kept are still there — the fix is a filter, not a blanket removal.
    expect(closed.ctx.systemAppend).toContain('public-topic.md')
    await closed.finish()
  })

  it('does not inherit the interactive persona (deliberate, not an omission)', async () => {
    writeSkill('analyze-applog', 'Read an application log')
    const { ctx, finish } = await contextOf()
    // A persona for helping a human triage a defect is not a persona for unattended
    // automation. assembleMode's persona half is discarded and no pack fragments are passed;
    // the automation identity comes from RoutinesService's unattended preamble instead.
    expect(ctx.systemAppend).not.toContain(NEUTRAL_PERSONA.trim().slice(0, 40))
    // …while the skill half of the SAME assembleMode call is used, which is the whole point of
    // this being a decision rather than the gap it looks like.
    expect(ctx.systemAppend).toContain('analyze-applog')
    await finish()
  })

  it("threads the user's tool-risk overrides through", async () => {
    // HONESTY NOTE, because the review's framing does not survive contact with risk.ts:
    // `toolRisk` is consulted ONLY on the generic `mcp__<server>__<tool>` branch, which sits
    // BELOW the hardcoded NATIVE_TOOL_RISK table — so it cannot move any `mcp__argus__*`
    // verdict — and a background session registers no connector servers at all
    // (`extraMcpServers` omitted, by design). So today this dep is INERT in a routine run: it
    // is threaded so the wire is correct if connectors ever reach one, not because it changes
    // a verdict now. The assertion drives the classifier with a connector-shaped tool name
    // directly (canUseTool classifies whatever name it is handed; registration is irrelevant),
    // which is what makes the wire observable at all.
    const sdk = fakeSdk()
    const run = createRoutineTurnRunner(
      runnerDeps(createClaudeDriver(sdk.createQuery), {
        toolRisk: () => ({ 'jira/create_issue': 'low' })
      })
    )
    const p = run(request())
    const canUse = await canUseToolOf(sdk)
    const out = await canUse(
      'mcp__jira__create_issue',
      { summary: 'x' },
      { signal: new AbortController().signal }
    )
    // Without the override this is a write-shaped connector tool: MEDIUM ask, and every ask is
    // denied under unattended.
    expect(out.behavior).toBe('allow')
    sdk.messages.push(RESULT_SUCCESS)
    await p
  })
})

describe('createRoutineTurnRunner — pack CLIs keep their LOW-risk allowlist', () => {
  it('allows a pack-declared CLI that would otherwise be DENIED under unattended', async () => {
    // HONESTY NOTE: the review said a routine without `packCliNames` would have its pack CLIs
    // classified `ask` and therefore denied. That is NOT what risk.ts does — an unrecognized
    // bash program falls through every classifier to the final `allow / LOW` default, so a pack
    // CLI with an ordinary name (`applog`) runs fine either way. The allowlist only decides
    // anything for a pack CLI whose name COLLIDES with the raw-text-tool list
    // (grep/rg/cat/awk/sed/head/tail) on an `evidence/` path, where the allowlist check runs
    // first and wins. That collision is the only case where the missing dep changed behaviour,
    // so it is the case this test drives.
    const cmd = { command: 'rg needle evidence/app.log' }

    const withNames = fakeSdk()
    const runAllowed = createRoutineTurnRunner(
      runnerDeps(createClaudeDriver(withNames.createQuery), { packCliNames: () => ['rg'] })
    )
    const pAllowed = runAllowed(request())
    const canUse = await canUseToolOf(withNames)
    const allowed = await canUse('Bash', cmd, { signal: new AbortController().signal })
    expect(allowed.behavior).toBe('allow')
    withNames.messages.push(RESULT_SUCCESS)
    await pAllowed

    // Control: the identical command with no pack names declared is MEDIUM-ask, and every ask
    // is denied outright under unattended — there is no renderer to answer it.
    const without = fakeSdk()
    const runDenied = createRoutineTurnRunner(runnerDeps(createClaudeDriver(without.createQuery)))
    const pDenied = runDenied(request())
    const canUse2 = await canUseToolOf(without)
    const denied = await canUse2('Bash', cmd, { signal: new AbortController().signal })
    expect(denied.behavior).toBe('deny')
    expect(denied.message).toMatch(/unattended/i)
    without.messages.push(RESULT_SUCCESS)
    await pDenied
  })
})
