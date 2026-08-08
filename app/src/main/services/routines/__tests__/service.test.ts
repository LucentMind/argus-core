import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { getCase } from '../../caseService'
import { listRoutineRuns } from '../runs'
import { RoutineStore } from '../store'
import { RoutinesService } from '../service'
import type { BackgroundTurnParams } from '../../agent/background'
import type { RoutinesPayload } from '../../../../shared/routines'

let home: string
let db: DatabaseSync
let store: RoutineStore
const NOW = new Date('2026-08-03T02:00:00.000Z')

const PREAMBLE =
  `You are running unattended as the routine "Sweep". No user is present: ` +
  `never ask questions, make reasonable assumptions, note anything that needs human ` +
  `review, and end with a concise summary of what you did and found.\n\n`

// The watermark sentence for a routine with no prior successful run — this is what run 1 of any
// fresh routine sees, appended to PREAMBLE above.
const FIRST_RUN_WATERMARK =
  `This is the first run of this routine — there is no previous run to compare against.\n\n`

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rsvc-'))
  db = openDb(path.join(home, 'argus.db'))
  store = new RoutineStore(home)
  store.upsert({ id: 'sweep', name: 'Sweep', prompt: 'sweep it', timeoutMs: 1000 })
})
afterEach(() => {
  store.close()
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const sessionRows = (): { id: number; driver_kind: string; model: string | null }[] =>
  db.prepare(`SELECT id, driver_kind, model FROM sessions ORDER BY id`).all() as unknown as {
    id: number
    driver_kind: string
    model: string | null
  }[]

const caseCount = (): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM cases`).get() as unknown as { n: number }).n

describe('RoutinesService', () => {
  it('runs a routine end to end: case, session row, run record, summary', async () => {
    const calls: BackgroundTurnParams[] = []
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async (p) => {
        calls.push(p)
        return { status: 'ok', text: 'nothing new' }
      },
      now: () => NOW
    })
    svc.startRun('sweep')
    await svc.whenIdle()

    const rec = getCase(db, 'routine-sweep')
    expect(rec).toBeTruthy()
    expect(rec?.title).toBe('Routine: Sweep')

    expect(calls).toHaveLength(1)
    expect(calls[0].caseId).toBe(rec!.id)
    expect(calls[0].caseSlug).toBe('routine-sweep')
    // Exact preamble, then the first-run watermark sentence, then the routine's own prompt.
    expect(calls[0].prompt).toBe(PREAMBLE + FIRST_RUN_WATERMARK + 'sweep it')
    expect(calls[0].timeoutMs).toBe(1000)
    expect(calls[0].model).toBeUndefined()

    const sessions = sessionRows()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].driver_kind).toBe('claude-agent-sdk')
    expect(sessions[0].model).toBeNull()
    expect(calls[0].sessionId).toBe(sessions[0].id)

    const [run] = listRoutineRuns(db)
    expect(run).toMatchObject({
      routineId: 'sweep',
      caseSlug: 'routine-sweep',
      status: 'ok',
      summary: 'nothing new',
      error: null,
      sessionId: calls[0].sessionId,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString()
    })
  })

  it('honours driverKind and model overrides', async () => {
    store.upsert({
      id: 'sweep',
      name: 'Sweep',
      prompt: 'sweep it',
      timeoutMs: 1000,
      driverKind: 'copilot',
      model: 'gpt-5'
    })
    const calls: BackgroundTurnParams[] = []
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async (p) => {
        calls.push(p)
        return { status: 'ok', text: 'done' }
      }
    })
    svc.startRun('sweep')
    await svc.whenIdle()
    expect(calls[0].model).toBe('gpt-5')
    const sessions = sessionRows()
    expect(sessions[0].driver_kind).toBe('copilot')
    expect(sessions[0].model).toBe('gpt-5')
  })

  it('reuses the routine case on the second run', async () => {
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => ({ status: 'ok', text: 'ok' })
    })
    svc.startRun('sweep')
    await svc.whenIdle()
    svc.startRun('sweep')
    await svc.whenIdle()

    expect(caseCount()).toBe(1)
    expect(listRoutineRuns(db)).toHaveLength(2)
    expect(sessionRows()).toHaveLength(2)
  })

  it('rejects while busy, unknown ids, and disabled routines', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => {
        await gate
        return { status: 'ok', text: '' }
      }
    })
    svc.startRun('sweep')
    expect(() => svc.startRun('sweep')).toThrow(/already running/)
    // Validation of the id must not be masked by the busy check.
    expect(() => svc.startRun('nope')).toThrow(/Unknown routine: nope/)
    release()
    await svc.whenIdle()
    // Only the one accepted run ever reached the DB.
    expect(listRoutineRuns(db)).toHaveLength(1)

    store.upsert({ id: 'off', name: 'Off', prompt: 'x', enabled: false })
    expect(() => svc.startRun('off')).toThrow(/Routine is disabled: off/)
    // A rejected startRun leaves the service idle and writes nothing.
    await svc.whenIdle()
    expect(listRoutineRuns(db)).toHaveLength(1)
    expect(svc.payload().runningId).toBeNull()
  })

  it('records failed when runTurn rejects — no running row left behind', async () => {
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => {
        throw new Error('driver exploded')
      }
    })
    svc.startRun('sweep')
    await expect(svc.whenIdle()).resolves.toBeUndefined()
    const [run] = listRoutineRuns(db)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/driver exploded/)
    expect(run.finishedAt).toBeTruthy()
    expect(listRoutineRuns(db).filter((r) => r.status === 'running')).toEqual([])
    // The service is idle again and accepts the next run.
    expect(svc.payload().runningId).toBeNull()
    expect(() => svc.startRun('sweep')).not.toThrow()
    // This second run must settle before the test (and its afterEach db.close/rmSync) ends —
    // otherwise it's left in flight against fixtures that are about to be torn down.
    await svc.whenIdle()
  })

  it('records a failed run when case/session setup throws — never a stuck running row', async () => {
    // argusHome is a FILE, so createCase's mkdir of the case dir throws.
    const blocked = path.join(home, 'blocked')
    fs.writeFileSync(blocked, 'not a directory')
    let ran = false
    const svc = new RoutinesService({
      db,
      argusHome: blocked,
      store,
      runTurn: async () => {
        ran = true
        return { status: 'ok', text: 'x' }
      }
    })
    svc.startRun('sweep')
    await expect(svc.whenIdle()).resolves.toBeUndefined()
    expect(ran).toBe(false)
    const [run] = listRoutineRuns(db)
    expect(run.status).toBe('failed')
    expect(run.error).toBeTruthy()
    expect(listRoutineRuns(db).filter((r) => r.status === 'running')).toEqual([])
    expect(svc.payload().runningId).toBeNull()
  })

  it('maps timeout and failed results, keeping partial text as the summary', async () => {
    const svcTimeout = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => ({
        status: 'timeout',
        text: 'got partway',
        error: 'timed out after 1000ms'
      })
    })
    svcTimeout.startRun('sweep')
    await svcTimeout.whenIdle()
    expect(listRoutineRuns(db)[0]).toMatchObject({
      status: 'timeout',
      summary: 'got partway',
      error: 'timed out after 1000ms'
    })

    const svcFailed = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => ({ status: 'failed', text: '', error: 'session exited' })
    })
    svcFailed.startRun('sweep')
    await svcFailed.whenIdle()
    expect(listRoutineRuns(db)[0]).toMatchObject({
      status: 'failed',
      summary: null,
      error: 'session exited'
    })
  })

  it('whenIdle resolves when nothing has ever run', async () => {
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async () => ({ status: 'ok', text: '' })
    })
    await expect(svc.whenIdle()).resolves.toBeUndefined()
  })

  it('payload() reports routines, runningId, and runs; notify fires at start and finish', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const seen: RoutinesPayload[] = []
    const notify = vi.fn(() => {
      seen.push(svc.payload())
    })
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      notify,
      runTurn: async () => {
        await gate
        return { status: 'ok', text: 'swept' }
      }
    })

    const before = svc.payload()
    expect(before.routines.map((r) => r.id)).toEqual(['sweep'])
    expect(before.loadError).toBeNull()
    expect(before.runningId).toBeNull()
    expect(before.runs).toEqual([])

    svc.startRun('sweep')
    const during = svc.payload()
    expect(during.runningId).toBe('sweep')
    expect(during.runs[0]).toMatchObject({ routineId: 'sweep', status: 'running' })

    release()
    await svc.whenIdle()

    const after = svc.payload()
    expect(after.runningId).toBeNull()
    expect(after.runs[0]).toMatchObject({ status: 'ok', summary: 'swept' })

    // Three notifications: run opened (no session yet), session attached while still running
    // (the fix under test), and the settled finish. A consumer watching notify must be able to
    // open the live agent session the moment it exists, not only after the run completes.
    expect(notify).toHaveBeenCalledTimes(3)

    expect(seen[0]).toMatchObject({ runningId: 'sweep' })
    expect(seen[0].runs[0]).toMatchObject({ status: 'running', sessionId: null })

    // The session-link notification: still running, but sessionId is now populated and matches
    // the session row actually created for this run.
    const sessionId = sessionRows()[0].id
    expect(seen[1]).toMatchObject({ runningId: 'sweep' })
    expect(seen[1].runs[0]).toMatchObject({ status: 'running', sessionId })

    // The finish notification must already show the settled state, not a stale running one.
    expect(seen[2].runningId).toBeNull()
    expect(seen[2].runs[0]).toMatchObject({ status: 'ok', summary: 'swept', sessionId })
  })
})

describe('watermark', () => {
  it('tells a first run that it is the first', async () => {
    const calls: BackgroundTurnParams[] = []
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async (p) => {
        calls.push(p)
        return { status: 'ok', text: 'done' }
      },
      now: () => NOW
    })
    svc.startRun('sweep')
    await svc.whenIdle()
    expect(calls[0].prompt).toContain('This is the first run of this routine')
    expect(calls[0].prompt).toContain('sweep it')
  })

  it('hands the next run the last SUCCESSFUL finish time', async () => {
    const calls: BackgroundTurnParams[] = []
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async (p) => {
        calls.push(p)
        return { status: 'ok', text: 'done' }
      },
      now: () => NOW
    })
    svc.startRun('sweep')
    await svc.whenIdle()
    svc.startRun('sweep')
    await svc.whenIdle()
    expect(calls[1].prompt).toContain(NOW.toISOString())
    expect(calls[1].prompt).toContain('changed since')
    expect(calls[1].prompt).not.toContain('first run')
  })

  it('does not advance the watermark past a failed run', async () => {
    const calls: BackgroundTurnParams[] = []
    let outcome: 'ok' | 'failed' = 'failed'
    const svc = new RoutinesService({
      db,
      argusHome: home,
      store,
      runTurn: async (p) => {
        calls.push(p)
        return outcome === 'ok'
          ? { status: 'ok', text: 'done' }
          : { status: 'failed', text: '', error: 'boom' }
      },
      now: () => NOW
    })
    svc.startRun('sweep')
    await svc.whenIdle()
    outcome = 'ok'
    svc.startRun('sweep')
    await svc.whenIdle()
    // Run 2 follows a FAILED run 1, so it is still the first run that matters.
    expect(calls[1].prompt).toContain('This is the first run of this routine')
  })
})
