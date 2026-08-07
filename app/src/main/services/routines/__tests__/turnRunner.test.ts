import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createSession } from '../../agent/sessionStore'
import { createDetection } from '../../packs/detection'
import { createClaudeDriver } from '../../agent/drivers/claude'
import { fakeSdk, flush } from '../../agent/__tests__/helpers/fakeSdk'
import { createRoutineTurnRunner, type RoutineTurnRunnerDeps } from '../turnRunner'
import { RoutineStore } from '../store'
import { RoutinesService } from '../service'
import { listRoutineRuns } from '../runs'
import type { AgentDriver } from '../../agent/driver'
import type { RoutineTurnRequest } from '../service'

/**
 * The production binding of `RoutinesService.runTurn`.
 *
 * This is the seam the whole-branch review found empty: the driver kind a run recorded was not
 * necessarily the driver it ran on. The binding used to live in an inline closure in
 * `main/index.ts`, which imports electron at module scope and is therefore unreachable from any
 * runtime test — so the defect could not go red anywhere. Extracting `turnRunner.ts` is what
 * makes these assertions possible at all.
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
