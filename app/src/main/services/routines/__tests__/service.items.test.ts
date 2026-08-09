import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase, findCaseByJiraKey } from '../../caseService'
import { RoutinesService, type RoutineTurnRequest, type RoutineRunFinished } from '../service'
import { listRunItems, runItemForCase } from '../runItems'
import { lastSuccessAt } from '../runs'
import { readRoutineCursor } from '../cursors'
import type { ScopeResolver } from '../scopeResolver'
import type { RoutineDef } from '../../../../shared/routines'

/**
 * The service↔items↔turnRunner seam. Increment 2's Critical survived ten clean per-task reviews
 * because nothing crossed the service↔scheduler seam; these tests drive a real scope through
 * resolution, ingest and a fake turn into real item rows, cursor rows and case rows.
 */

let tmp: string
let db: DatabaseSync

const routine = (over: Partial<RoutineDef> = {}): RoutineDef =>
  ({
    id: 'nightly',
    name: 'Nightly',
    prompt: 'triage it',
    timeoutMs: 600_000,
    enabled: true,
    scope: { kind: 'jira-jql', jql: 'project = ABC', cursorField: 'created' },
    maxItemsPerRun: 2,
    ...over
  }) as RoutineDef

const storeOf = (r: RoutineDef): unknown => ({
  list: () => [r],
  get: (id: string) => (id === r.id ? r : undefined),
  loadError: () => null
})

/**
 * Resolver whose Jira half is scripted and whose ingest creates a real case.
 *
 * `ingestJiraItem` ADOPTS an existing case rather than creating a second one, because that is
 * what the interface promises ("creating or adopting", scopeResolver.ts) and what the real Jira
 * ingest does. A fake that always INSERTs would make every re-visit of a ticket throw on the
 * UNIQUE slug constraint, which would turn the draft-skip rule below into an untestable one.
 *
 * `created` mirrors the real resolver's `findCaseByJiraKey`-vs-`createFromTicket` branch
 * (services/jiraScopeResolver.ts): false when the case already existed before this call. The
 * caller (RoutinesService.materializeItem) uses it to decide whether stamping `origin: 'routine'`
 * is safe — see the "adopted case" test below.
 *
 * Adoption here keys off `jira_key` via `findCaseByJiraKey`, same as production — NOT off the
 * slug. A fake that looked cases up by `key.toLowerCase()` would still pass every test where the
 * slug happens to equal the lowercased key (true of every case this file creates), but that is
 * exactly the divergence that would hide a real adopt-by-slug regression: production would never
 * find a case whose slug differs from its key, while a slug-keyed fake would find it anyway.
 */
function fakeResolver(
  issues: Array<{ key: string; created: string }>,
  opts: { failOn?: string } = {}
): ScopeResolver {
  return {
    resolveJql: async (
      _jql: string,
      _f: 'created' | 'updated',
      cursor: string | null,
      limit: number
    ) =>
      issues
        .filter((i) => cursor === null || i.created >= cursor)
        .slice(0, limit)
        .map((i) => ({ key: i.key, cursorValue: i.created })),
    ingestJiraItem: async (key: string) => {
      if (key === opts.failOn) throw new Error(`ingest failed for ${key}`)
      const existing = findCaseByJiraKey(db, key)
      if (existing) return { caseSlug: existing.slug, created: false }
      const slug = key.toLowerCase()
      createCase(db, tmp, { slug, title: key, jiraKey: key })
      return { caseSlug: slug, created: true }
    }
  }
}

const build = (
  r: RoutineDef,
  resolver: ReturnType<typeof fakeResolver>,
  turns: string[] = [],
  requests: RoutineTurnRequest[] = []
): RoutinesService =>
  new RoutinesService({
    db,
    argusHome: tmp,
    store: storeOf(r) as never,
    scopeResolver: resolver,
    runTurn: async (p) => {
      turns.push(p.caseSlug)
      requests.push(p)
      return { status: 'ok', text: `did ${p.caseSlug}` }
    },
    now: () => new Date('2026-08-08T02:00:00.000Z')
  })

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-items-'))
  db = openDb(path.join(tmp, 'a.sqlite'))
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Polls a macrotask at a time (each tick flushes every pending microtask) until `cond` is true
 *  or `maxTicks` is exhausted — for driving a real service up to a specific point mid-run (e.g.
 *  "item 2's turn has started") without assuming a fixed number of intervening `await`s. */
async function flushUntil(cond: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error(`flushUntil: condition never became true within ${maxTicks} ticks`)
}

describe('scoped runs', () => {
  it('runs ONE turn per item and records an item row for each', async () => {
    const turns: string[] = []
    const svc = build(
      routine(),
      fakeResolver([
        { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
        { key: 'ABC-2', created: '2026-08-02T00:00:00.000Z' }
      ]),
      turns
    )
    svc.startRun('nightly')
    await svc.whenIdle()

    expect(turns).toEqual(['abc-1', 'abc-2'])
    const runId = svc.payload().runs[0].id
    const items = listRunItems(db, [runId])
    expect(items.map((i) => [i.itemKey, i.status])).toEqual([
      ['ABC-1', 'processed'],
      ['ABC-2', 'processed']
    ])
  })

  it("hands each item's turn that item's OWN run-item id", async () => {
    // THE CHAIN THE PLAN NEVER MENTIONED. `propose_case_triage` is advertised only to a session
    // built with a `currentRunItemId` thunk and refuses without an id even then (nativeTools.ts),
    // so without this field every suggestion path is dead in production while every unit test
    // still passes. Asserted against the ROWS rather than a captured constant, so an
    // off-by-one id — the failure that would silently attach one item's suggestion to another —
    // cannot pass.
    const requests: RoutineTurnRequest[] = []
    const svc = build(
      routine(),
      fakeResolver([
        { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
        { key: 'ABC-2', created: '2026-08-02T00:00:00.000Z' }
      ]),
      [],
      requests
    )
    svc.startRun('nightly')
    await svc.whenIdle()

    const items = listRunItems(db, [svc.payload().runs[0].id])
    expect(items).toHaveLength(2)
    expect(requests.map((r) => r.runItemId)).toEqual(items.map((i) => i.id))
    // Each item's turn is bound to its own case, not the previous item's.
    expect(requests.map((r) => r.caseSlug)).toEqual(items.map((i) => i.caseSlug))
  })

  it('tells the turn which item it is processing', async () => {
    const requests: RoutineTurnRequest[] = []
    const svc = build(
      routine(),
      fakeResolver([{ key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' }]),
      [],
      requests
    )
    svc.startRun('nightly')
    await svc.whenIdle()
    // The unattended preamble is still there (it is what tells the model no human is present),
    // and the item sentence is added to it rather than replacing it.
    expect(requests[0].prompt).toContain('You are running unattended as the routine "Nightly"')
    expect(requests[0].prompt).toContain('You are processing item ABC-1')
    expect(requests[0].prompt).toContain('propose_case_triage')
    expect(requests[0].prompt.endsWith('triage it')).toBe(true)
  })

  it('marks each item case as a draft', async () => {
    const svc = build(
      routine(),
      fakeResolver([{ key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' }])
    )
    svc.startRun('nightly')
    await svc.whenIdle()
    expect(getCase(db, 'abc-1')!.reviewState).toBe('draft')
    expect(getCase(db, 'abc-1')!.origin).toBe('routine')
  })

  it(
    'leaves an ADOPTED case origin alone: a ticket the user already opened by hand keeps ' +
      "origin 'user', not 'routine'",
    async () => {
      // Task 11's reviewer finding: ingestJiraItem used to return only `{ caseSlug }`, so
      // materializeItem could not tell "just created" from "already existed" and stamped
      // `origin: 'routine'` unconditionally — relabelling a human-created case. `created: false`
      // (fakeResolver, mirroring the real resolver's findCaseByJiraKey branch) is what lets
      // materializeItem skip ensureCaseOrigin here.
      createCase(db, tmp, { slug: 'abc-1', title: 'Human-opened', jiraKey: 'ABC-1' })
      const svc = build(
        routine(),
        fakeResolver([{ key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' }])
      )
      svc.startRun('nightly')
      await svc.whenIdle()
      expect(getCase(db, 'abc-1')!.origin).toBe('user')
      // Still worked as a draft — adoption means "work it in place", not "skip it".
      expect(getCase(db, 'abc-1')!.reviewState).toBe('draft')
    }
  )

  it('records the run with per-outcome counts, and opens no routine-<id> case', async () => {
    const svc = build(
      routine({ maxItemsPerRun: 2 }),
      fakeResolver([
        { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
        { key: 'ABC-2', created: '2026-08-02T00:00:00.000Z' },
        { key: 'ABC-3', created: '2026-08-03T00:00:00.000Z' }
      ])
    )
    svc.startRun('nightly')
    await svc.whenIdle()
    const run = svc.payload().runs[0]
    expect(run.status).toBe('ok')
    expect(run.summary).toBe('2 processed · 1 carried to the next run')
    // The shared `routine-<id>` case is the UNSCOPED shape. A scoped run works in the items'
    // own cases, so creating one here would leave an empty case in the user's list forever.
    expect(getCase(db, 'routine-nightly')).toBeNull()
    // Finding 2: the run row itself must not claim a case it never created either — the UI's
    // "Open case" button reads exactly this field.
    expect(run.caseSlug).toBeNull()
  })

  it('carries the remainder to the next run instead of dropping it', async () => {
    const issues = [
      { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
      { key: 'ABC-2', created: '2026-08-02T00:00:00.000Z' },
      { key: 'ABC-3', created: '2026-08-03T00:00:00.000Z' }
    ]
    const turns: string[] = []
    const svc = build(routine({ maxItemsPerRun: 2 }), fakeResolver(issues), turns)
    svc.startRun('nightly')
    await svc.whenIdle()
    expect(turns).toEqual(['abc-1', 'abc-2'])

    svc.startRun('nightly')
    await svc.whenIdle()
    // Run 2 starts where run 1 stopped, and does NOT redo ABC-2 despite the inclusive boundary.
    expect(turns).toEqual(['abc-1', 'abc-2', 'abc-3'])
  })

  it('reaches BOTH items sharing one timestamp instead of starving on the boundary', async () => {
    // The inclusive `>=` boundary means run 2's window always re-contains run 1's last item. If
    // the query asked for exactly `maxItemsPerRun` rows, that one already-attempted key would
    // fill the whole window and ABC-2 would never be reachable — on this run or any future one.
    const turns: string[] = []
    const svc = build(
      routine({ maxItemsPerRun: 1 }),
      fakeResolver([
        { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
        { key: 'ABC-2', created: '2026-08-01T00:00:00.000Z' }
      ]),
      turns
    )
    svc.startRun('nightly')
    await svc.whenIdle()
    expect(turns).toEqual(['abc-1'])

    svc.startRun('nightly')
    await svc.whenIdle()
    expect(turns).toEqual(['abc-1', 'abc-2'])
  })

  it('a failing item does not stop the items behind it, and the cursor still advances', async () => {
    const turns: string[] = []
    const svc = build(
      routine({ maxItemsPerRun: 5 }),
      fakeResolver(
        [
          { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
          { key: 'ABC-2', created: '2026-08-02T00:00:00.000Z' },
          { key: 'ABC-3', created: '2026-08-03T00:00:00.000Z' }
        ],
        { failOn: 'ABC-2' }
      ),
      turns
    )
    svc.startRun('nightly')
    await svc.whenIdle()

    expect(turns).toEqual(['abc-1', 'abc-3'])
    const items = listRunItems(db, [svc.payload().runs[0].id])
    expect(items.map((i) => [i.itemKey, i.status])).toEqual([
      ['ABC-1', 'processed'],
      ['ABC-2', 'failed'],
      ['ABC-3', 'processed']
    ])
    expect(items[1].error).toMatch(/ingest failed for ABC-2/)
    // The poison-pill guard: the cursor moved past the failure.
    expect(readRoutineCursor(db, 'nightly')).toBe('2026-08-03T00:00:00.000Z')
  })

  it('advances the cursor past a failure that is the LAST item of the run', async () => {
    // The discriminating case for "attempted, not succeeded". With a failure in the MIDDLE, a
    // cursor that only advanced on success would still be dragged forward by the item behind it,
    // so the middle-failure test cannot tell the two rules apart. Here nothing follows the
    // failure: if the cursor only moved on success it would stall on ABC-2 forever, and every
    // future window would start on the poison pill.
    const svc = build(
      routine({ maxItemsPerRun: 2 }),
      fakeResolver(
        [
          { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
          { key: 'ABC-2', created: '2026-08-02T00:00:00.000Z' }
        ],
        { failOn: 'ABC-2' }
      )
    )
    svc.startRun('nightly')
    await svc.whenIdle()
    expect(readRoutineCursor(db, 'nightly')).toBe('2026-08-02T00:00:00.000Z')
  })

  it('keeps the cursor of the items it did attempt when the run aborts mid-loop', async () => {
    // Why the cursor is written PER ITEM and not once at the end of the run. A run that dies
    // partway — here the item-row insert itself fails, as it would with a full or locked disk,
    // and as an app quit or crash does more bluntly — must not replay the items it already
    // attempted on the next run. A single write after the loop never happens at all on this path.
    const turns: string[] = []
    const svc = build(
      routine({ maxItemsPerRun: 5 }),
      fakeResolver([
        { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
        { key: 'ABC-2', created: '2026-08-02T00:00:00.000Z' }
      ]),
      turns
    )
    db.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON routine_run_items
       WHEN NEW.item_key = 'ABC-2'
       BEGIN SELECT RAISE(ABORT, 'disk full'); END`
    )
    svc.startRun('nightly')
    await svc.whenIdle()

    expect(turns).toEqual(['abc-1'])
    const run = svc.payload().runs[0]
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/disk full/)
    expect(readRoutineCursor(db, 'nightly')).toBe('2026-08-01T00:00:00.000Z')
    // Minor 5: the abort must not discard the count of items already processed before it hit.
    expect(run.summary).toBe('1 processed')
  })

  it('records an item failed when its turn does not come back ok', async () => {
    // A turn that times out must not leave a case flagged as a draft with nothing to review.
    const svc = new RoutinesService({
      db,
      argusHome: tmp,
      store: storeOf(routine()) as never,
      scopeResolver: fakeResolver([{ key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' }]),
      runTurn: async () => ({ status: 'timeout', text: '', error: 'timed out after 600000ms' }),
      now: () => new Date('2026-08-08T02:00:00.000Z')
    })
    svc.startRun('nightly')
    await svc.whenIdle()

    const item = runItemForCase(db, 'abc-1')!
    expect(item.status).toBe('failed')
    expect(item.error).toMatch(/timed out/)
    expect(getCase(db, 'abc-1')!.reviewState).toBeNull()
    // Every item failed, so the run itself failed.
    expect(svc.payload().runs[0].status).toBe('failed')
  })

  it('SKIPS an item whose case is still an unreviewed draft, and runs no turn for it', async () => {
    const turns: string[] = []
    const issues = [{ key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' }]
    const svc = build(routine(), fakeResolver(issues), turns)
    svc.startRun('nightly')
    await svc.whenIdle()
    expect(turns).toEqual(['abc-1'])

    // Second run: the draft is still unreviewed. Force it back into the window.
    db.prepare(`DELETE FROM routine_run_items`).run()
    svc.startRun('nightly')
    await svc.whenIdle()

    expect(turns).toEqual(['abc-1']) // no second turn
    const latest = runItemForCase(db, 'abc-1')!
    expect(latest.status).toBe('skipped')
  })

  it('an unscoped routine behaves exactly as it did in increment 2 — one turn, no items', async () => {
    const turns: string[] = []
    const svc = build(
      routine({ scope: undefined, maxItemsPerRun: undefined }),
      fakeResolver([]),
      turns
    )
    svc.startRun('nightly')
    await svc.whenIdle()
    expect(turns).toEqual(['routine-nightly'])
    expect(listRunItems(db, [svc.payload().runs[0].id])).toEqual([])
    // Unchanged by the Finding 2 fix: only a SCOPED run's row gets a null case_slug.
    expect(svc.payload().runs[0].caseSlug).toBe('routine-nightly')
  })

  it('stopForQuit interrupts the item currently mid-turn, and the rest of the scope stays unattempted', async () => {
    // The abort must reach a SCOPED run's per-item turn, not only the unscoped path's single
    // turn — `runItemTurn` threads the same `runningAbort.signal` `execute` does.
    const started: string[] = []
    let capturedSignal: AbortSignal | undefined
    const svc = new RoutinesService({
      db,
      argusHome: tmp,
      store: storeOf(routine({ maxItemsPerRun: 5 })) as never,
      scopeResolver: fakeResolver([
        { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
        { key: 'ABC-2', created: '2026-08-02T00:00:00.000Z' }
      ]),
      // Mirrors runBackgroundTurn's own contract (agent/background.ts): hangs until `signal`
      // fires, then settles failed — the fake doubles as proof the signal it captured is the
      // one `stopForQuit` actually aborts.
      runTurn: (p) =>
        new Promise((resolve) => {
          started.push(p.caseSlug)
          capturedSignal = p.signal
          p.signal?.addEventListener(
            'abort',
            () =>
              resolve({ status: 'failed', text: '', error: 'turn aborted: the app is quitting' }),
            { once: true }
          )
        }),
      now: () => new Date('2026-08-08T02:00:00.000Z')
    })

    svc.startRun('nightly')
    // Let the resolver + first item's turn actually start before quitting — everything between
    // `startRun` and the first `runTurn` call is async (scope resolution, ingest), so this must
    // wait rather than assume it already happened.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['abc-1'])

    svc.stopForQuit()
    expect(capturedSignal?.aborted).toBe(true)
    await svc.whenIdle()

    // ABC-2 was never opened — no row, no turn — rather than started and then failed.
    expect(started).toEqual(['abc-1'])
    const run = svc.payload().runs[0]
    expect(listRunItems(db, [run.id]).map((i) => i.itemKey)).toEqual(['ABC-1'])
    expect(run.status).toBe('failed')
    // A quit-cut run must never move the watermark — see the two tests below for why this one
    // alone cannot prove the general rule (it happens to land on `failed` even under the OLD,
    // buggy `processed === 0 && failed > 0 ? 'failed' : 'ok'` computation, since nothing here
    // was ever `processed`).
    expect(lastSuccessAt(db, 'nightly')).toBeNull()
  })

  it('records failed, not ok, when quit interrupts item 2 of a 3-item scope — processed=1, failed=1 must not read ok', async () => {
    // The bug this pins: `processed === 0 && failed > 0 ? 'failed' : 'ok'` only ever catches a
    // quit that happens to leave `processed` at zero. The moment even ONE earlier item finished
    // cleanly before quit cut the run short, that formula reads `ok` — exactly wrong, since the
    // run did NOT finish on its own terms and item 3 was never even opened.
    const started: string[] = []
    const svc = new RoutinesService({
      db,
      argusHome: tmp,
      store: storeOf(routine({ maxItemsPerRun: 5 })) as never,
      scopeResolver: fakeResolver([
        { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
        { key: 'ABC-2', created: '2026-08-02T00:00:00.000Z' },
        { key: 'ABC-3', created: '2026-08-03T00:00:00.000Z' }
      ]),
      runTurn: (p) => {
        started.push(p.caseSlug)
        if (p.caseSlug === 'abc-1') return Promise.resolve({ status: 'ok', text: 'did abc-1' })
        // abc-2 (and, if ever reached, abc-3): mirrors runBackgroundTurn's real contract for
        // params.signal — hangs until aborted, then settles failed.
        return new Promise((resolve) => {
          p.signal?.addEventListener(
            'abort',
            () =>
              resolve({ status: 'failed', text: '', error: 'turn aborted: the app is quitting' }),
            { once: true }
          )
        })
      },
      now: () => new Date('2026-08-08T02:00:00.000Z')
    })

    svc.startRun('nightly')
    await flushUntil(() => started.includes('abc-2'))
    expect(started).toEqual(['abc-1', 'abc-2'])

    svc.stopForQuit()
    await svc.whenIdle()

    // abc-3 was never opened.
    expect(started).toEqual(['abc-1', 'abc-2'])
    const run = svc.payload().runs[0]
    expect(listRunItems(db, [run.id]).map((i) => i.itemKey)).toEqual(['ABC-1', 'ABC-2'])
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/quit/i)
    // THE assertion: a quit-cut run — even one with real, successful work behind it — must never
    // advance the "last successful run" watermark the next run's preamble reads (runs.ts).
    expect(lastSuccessAt(db, 'nightly')).toBeNull()
  })

  it('records failed, not ok, when quit fires during scope resolution — before any item is even opened', async () => {
    // The other shape of the same bug: quit lands while resolveTargets (a real, seconds-wide
    // Jira query) is still in flight. The loop's abort guard breaks on its very first iteration,
    // so processed=0 AND failed=0 — the old computation's `else` branch reads that as `ok`.
    const started: string[] = []
    let releaseResolve: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      releaseResolve = r
    })
    const svc = new RoutinesService({
      db,
      argusHome: tmp,
      store: storeOf(routine({ maxItemsPerRun: 5 })) as never,
      scopeResolver: {
        resolveJql: async () => {
          await gate
          return [{ key: 'ABC-1', cursorValue: '2026-08-01T00:00:00.000Z' }]
        },
        ingestJiraItem: async () => ({ caseSlug: 'x', created: true })
      },
      runTurn: (p) => {
        started.push(p.caseSlug)
        return new Promise(() => {}) // never reached in this test
      },
      now: () => new Date('2026-08-08T02:00:00.000Z')
    })

    svc.startRun('nightly')
    // Give resolveTargets a real chance to start awaiting `gate` before quitting.
    await new Promise((r) => setTimeout(r, 0))

    svc.stopForQuit()
    releaseResolve?.()
    await svc.whenIdle()

    expect(started).toEqual([])
    const run = svc.payload().runs[0]
    expect(listRunItems(db, [run.id])).toEqual([])
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/quit/i)
    expect(lastSuccessAt(db, 'nightly')).toBeNull()
  })

  it('records a failed run when the scope itself cannot be resolved', async () => {
    const svc = new RoutinesService({
      db,
      argusHome: tmp,
      store: storeOf(routine()) as never,
      scopeResolver: {
        resolveJql: async () => {
          throw new Error('JQL is invalid')
        },
        ingestJiraItem: async () => ({ caseSlug: 'x', created: true })
      },
      runTurn: async () => ({ status: 'ok', text: '' }),
      now: () => new Date('2026-08-08T02:00:00.000Z')
    })
    svc.startRun('nightly')
    await svc.whenIdle()
    const run = svc.payload().runs[0]
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/JQL is invalid/)
    // Nothing was ever attempted — no item row was even opened — so the inbox must not show a
    // "0 processed" summary next to the error, which reads as if the run had actually run.
    expect(run.summary).toBeNull()
  })

  it('records a failed run when no resolver is bound at all', async () => {
    // A host that cannot resolve scopes must say so, not report a clean run that did nothing.
    const svc = new RoutinesService({
      db,
      argusHome: tmp,
      store: storeOf(routine()) as never,
      runTurn: async () => ({ status: 'ok', text: '' }),
      now: () => new Date('2026-08-08T02:00:00.000Z')
    })
    svc.startRun('nightly')
    await svc.whenIdle()
    const run = svc.payload().runs[0]
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/scope resolver/i)
    expect(run.summary).toBeNull()
  })
})

describe('cases-scoped runs', () => {
  const casesRoutine = (): RoutineDef =>
    routine({ scope: { kind: 'cases' }, maxItemsPerRun: 5, prompt: 'sweep it' })

  it('works the case in place: no ingest, no cursor, and the origin is left alone', async () => {
    createCase(db, tmp, { slug: 'human-case', title: 'Opened by a person' })
    const turns: string[] = []
    const svc = build(casesRoutine(), fakeResolver([]), turns)
    svc.startRun('nightly')
    await svc.whenIdle()

    expect(turns).toEqual(['human-case'])
    // `cases` has no cursor at all — a forward-only cursor would visit each case once and never
    // again, which is the opposite of a sweep (items.ts).
    expect(readRoutineCursor(db, 'nightly')).toBeNull()
    // The case predates the run; relabelling it as routine-created would be a lie the case list
    // renders.
    expect(getCase(db, 'human-case')!.origin).toBe('user')
    expect(getCase(db, 'human-case')!.reviewState).toBe('draft')
    expect(runItemForCase(db, 'human-case')!.status).toBe('processed')
  })

  /**
   * The loop `setCaseReviewState`'s own docblock forbids, reached through the OTHER writer:
   * `acceptItem` calls `setCaseTriage`, and a `setCaseTriage` that moved `updated_at` made the
   * accepted case look freshly modified — so the next sweep re-drafted it, accepting that
   * re-drafted it again, forever, consuming the item cap while genuinely new cases starved.
   */
  it('does not re-select a case just because its suggestion was accepted', async () => {
    createCase(db, tmp, { slug: 'sweep-me', title: 'Stale case' })
    // The ordinary state of a case a sweep is about to look at: last modified BEFORE the run.
    // (The service clock is fixed at 2026-08-08T02:00Z; createCase stamps the real clock.)
    db.prepare(`UPDATE cases SET updated_at = ? WHERE slug = ?`).run(
      '2026-08-07T00:00:00.000Z',
      'sweep-me'
    )
    const turns: string[] = []
    const svc = build(casesRoutine(), fakeResolver([]), turns)

    svc.startRun('nightly')
    await svc.whenIdle()
    expect(turns).toEqual(['sweep-me'])

    const item = runItemForCase(db, 'sweep-me')!
    db.prepare(`UPDATE routine_run_items SET suggestion = ? WHERE id = ?`).run(
      JSON.stringify({ title: 'Retitled by the routine', tags: ['severity:high'], rationale: 'r' }),
      item.id
    )
    svc.acceptItem(item.id)
    const accepted = getCase(db, 'sweep-me')!
    expect(accepted.title).toBe('Retitled by the routine')
    // Accept cleared the draft flag, so the case is a candidate for the sweep again — the only
    // thing keeping it out of the next run is that accepting was not activity on the case.
    expect(accepted.reviewState).toBeNull()

    // THE LOOP, asserted first so a regression fails on the consequence rather than on the
    // timestamp that causes it: a second run must not touch the case again.
    svc.startRun('nightly')
    await svc.whenIdle()
    expect(turns).toEqual(['sweep-me'])
    expect(listRunItems(db, [svc.payload().runs[0].id])).toEqual([])
    expect(getCase(db, 'sweep-me')!.updatedAt).toBe('2026-08-07T00:00:00.000Z')
  })

  it('still re-selects a case a HUMAN touched after the run', async () => {
    // The other half of the rule: the sweep must keep working genuinely-modified cases. Without
    // this, "never re-select" would be satisfiable by breaking the sweep outright.
    createCase(db, tmp, { slug: 'sweep-me', title: 'Stale case' })
    db.prepare(`UPDATE cases SET updated_at = ? WHERE slug = ?`).run(
      '2026-08-07T00:00:00.000Z',
      'sweep-me'
    )
    const turns: string[] = []
    const svc = build(casesRoutine(), fakeResolver([]), turns)
    svc.startRun('nightly')
    await svc.whenIdle()
    svc.acceptItem(runItemForCase(db, 'sweep-me')!.id)

    db.prepare(`UPDATE cases SET updated_at = ? WHERE slug = ?`).run(
      '2026-08-08T09:00:00.000Z',
      'sweep-me'
    )
    svc.startRun('nightly')
    await svc.whenIdle()
    expect(turns).toEqual(['sweep-me', 'sweep-me'])
  })
})

describe('accept and dismiss', () => {
  it('accept applies the suggestion and clears the draft', async () => {
    const svc = build(
      routine(),
      fakeResolver([{ key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' }])
    )
    svc.startRun('nightly')
    await svc.whenIdle()
    const item = runItemForCase(db, 'abc-1')!
    db.prepare(`UPDATE routine_run_items SET suggestion = ? WHERE id = ?`).run(
      JSON.stringify({ title: 'Crash on empty payload', tags: ['severity:high'], rationale: 'r' }),
      item.id
    )

    svc.acceptItem(item.id)
    const kase = getCase(db, 'abc-1')!
    expect(kase.title).toBe('Crash on empty payload')
    expect(kase.tags).toEqual(['severity:high'])
    expect(kase.reviewState).toBeNull()
  })

  it('accept with no suggestion still clears the draft rather than throwing', async () => {
    const svc = build(
      routine(),
      fakeResolver([{ key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' }])
    )
    svc.startRun('nightly')
    await svc.whenIdle()
    svc.acceptItem(runItemForCase(db, 'abc-1')!.id)
    expect(getCase(db, 'abc-1')!.reviewState).toBeNull()
  })

  it('dismiss closes the case and LEAVES review_state set, so a dismissal is distinguishable', async () => {
    const svc = build(
      routine(),
      fakeResolver([{ key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' }])
    )
    svc.startRun('nightly')
    await svc.whenIdle()
    svc.dismissItem(runItemForCase(db, 'abc-1')!.id, 'rejected')
    const kase = getCase(db, 'abc-1')!
    expect(kase.status).toBe('closed')
    expect(kase.resolution).toBe('rejected')
    expect(kase.reviewState).toBe('draft')
  })

  it('accepting twice is idempotent, which is what a second window makes possible', async () => {
    const svc = build(
      routine(),
      fakeResolver([{ key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' }])
    )
    svc.startRun('nightly')
    await svc.whenIdle()
    const id = runItemForCase(db, 'abc-1')!.id
    svc.acceptItem(id)
    expect(() => svc.acceptItem(id)).not.toThrow()
    expect(getCase(db, 'abc-1')!.reviewState).toBeNull()
  })

  it('accept and dismiss on an unknown item are no-ops rather than throws', () => {
    const svc = build(routine(), fakeResolver([]))
    expect(() => svc.acceptItem(9999)).not.toThrow()
    expect(() => svc.dismissItem(9999, 'rejected')).not.toThrow()
  })

  /**
   * End to end over the real seam the finding describes: the inbox renders a run only while it
   * is unreviewed, and it is the ONLY accept/dismiss surface. Marking a run reviewed while its
   * drafts are un-actioned therefore stranded them permanently — the cases stayed `draft`, their
   * suggestions became unappliable, and a `cases`-scoped routine could never see them again.
   */
  it('refuses to mark a run reviewed while its drafts are un-actioned, then allows it', async () => {
    const svc = build(
      routine(),
      fakeResolver([
        { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
        { key: 'ABC-2', created: '2026-08-02T00:00:00.000Z' }
      ])
    )
    svc.startRun('nightly')
    await svc.whenIdle()
    const runId = svc.payload().runs[0].id
    expect(getCase(db, 'abc-1')!.reviewState).toBe('draft')
    expect(getCase(db, 'abc-2')!.reviewState).toBe('draft')

    expect(() => svc.markReviewed(runId)).toThrow(/2 draft items to accept/)
    expect(() => svc.markAllReviewed()).toThrow(/2 draft items in 1 run/)
    expect(svc.payload().unreviewedCount).toBe(1)

    svc.acceptItem(runItemForCase(db, 'abc-1')!.id)
    // One left, so it still refuses — and the message counts down.
    expect(() => svc.markReviewed(runId)).toThrow(/1 draft item to accept/)

    svc.dismissItem(runItemForCase(db, 'abc-2')!.id, 'rejected')
    svc.markReviewed(runId)
    expect(svc.payload().unreviewedCount).toBe(0)
  })
})

/**
 * D2 from the live run: a routine whose cursor can never advance again, reporting `ok` forever.
 *
 * Reached on a real Jira instance in seven runs. The cursor bound landed early enough that every
 * window came back FULL of issues the routine had already attempted; run 7 fetched 12 rows,
 * selected 0, and recorded `status: ok`, `0 processed`, `error: null` — while the response's own
 * `isLast: false` and page token proved more matching issues existed just past the window. From
 * the outside that run was identical to a quiet night.
 *
 * These two tests pin the distinction the service now makes, and they must be read as a pair: the
 * SATURATED window is the stall, the PARTIAL one is a quiet night, and only the first is a defect.
 */
describe('a jira-jql window that yields nothing', () => {
  /**
   * A bound that lands before every issue: the cursor is ignored, so each run re-fetches the same
   * rows. That is exactly what a cursor literal formatted in the wrong timezone did, and it is the
   * only thing about the live failure worth reproducing here — the formatting itself is pinned in
   * jiraDate's own tests.
   */
  const cursorBlindResolver = (issues: Array<{ key: string; created: string }>): ScopeResolver => ({
    resolveJql: async (_jql, _f, _cursor, limit) =>
      issues.slice(0, limit).map((i) => ({ key: i.key, cursorValue: i.created })),
    ingestJiraItem: async (key: string) => {
      const existing = findCaseByJiraKey(db, key)
      if (existing) return { caseSlug: existing.slug, created: false }
      const slug = key.toLowerCase()
      createCase(db, tmp, { slug, title: key, jiraKey: key })
      return { caseSlug: slug, created: true }
    }
  })

  const itemRowCount = (): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM routine_run_items`).get() as { c: number }).c

  /** Twelve issues — `maxItemsPerRun: 2` plus `CURSOR_BOUNDARY_SLACK: 10`, so one full window. */
  const twelve = Array.from({ length: 12 }, (_, n) => ({
    key: `ABC-${n + 1}`,
    created: `2026-08-03T15:${String(n + 30).padStart(2, '0')}:00.000+0200`
  }))

  it('refuses to report a clean ok once a FULL window is all already-attempted keys', async () => {
    const svc = build(routine({ maxItemsPerRun: 2 }), cursorBlindResolver(twelve))
    // Six runs at two items each attempt all twelve. The seventh is the live run's run 7.
    for (let i = 0; i < 6; i++) {
      svc.startRun('nightly')
      await svc.whenIdle()
    }
    expect(itemRowCount()).toBe(12)
    expect(svc.payload().runs.every((r) => r.status === 'ok')).toBe(true)

    svc.startRun('nightly')
    await svc.whenIdle()

    const stalled = svc.payload().runs[0]
    expect(stalled.summary).toBe('0 processed')
    // The whole point: `0 processed` alone is what a quiet night looks like too, so the run must
    // carry a signal of its own. Before this it was `status: ok`, `error: null`.
    expect(stalled.status).not.toBe('ok')
    expect(stalled.error).toMatch(/cursor cannot advance/)
    // No new item row was opened — the stall is diagnosed at resolution, not by attempting
    // anything.
    expect(itemRowCount()).toBe(12)
  })

  it('still reports a clean ok when the window is merely quiet', async () => {
    // The INCLUSIVE cursor boundary means the item that last moved the cursor comes back in every
    // later window (items.ts), so a nightly routine with nothing new resolves exactly one
    // already-attempted issue and selects nothing. That is healthy, self-correcting, and must not
    // be reported as a failure — which is why the rule keys off a FULL window rather than off an
    // empty selection.
    const svc = build(routine({ maxItemsPerRun: 2 }), cursorBlindResolver(twelve.slice(0, 1)))
    svc.startRun('nightly')
    await svc.whenIdle()
    expect(svc.payload().runs[0].summary).toBe('1 processed')

    svc.startRun('nightly')
    await svc.whenIdle()
    const quiet = svc.payload().runs[0]
    expect(quiet.status).toBe('ok')
    expect(quiet.error).toBeNull()
    expect(quiet.summary).toBe('0 processed')
  })
})

/**
 * The composition defect a rebase introduced: increment 4's `onRunFinished` announce and
 * increment 5's item loop landed on either side of an early `return`, so a scoped run — and
 * every one of `executeItems`'s four finish sites — could never reach it. service.test.ts's
 * `onRunFinished` tests all predate scopes (they only ever drive the unscoped path), so this is
 * the first coverage of the scoped side of that seam.
 *
 * Each test below pins a DIFFERENT one of the four finish sites in `executeItems`, plus the
 * unscoped path stays covered by service.test.ts's own "reports a finished run once" tests —
 * this file does not repeat those, it only adds what they structurally cannot reach.
 */
describe('onRunFinished reaches every finish site', () => {
  it('announces a normally-finished scoped run exactly once, with the same shape an unscoped run gets', async () => {
    const finished: RoutineRunFinished[] = []
    const svc = new RoutinesService({
      db,
      argusHome: tmp,
      store: storeOf(routine({ maxItemsPerRun: 2 })) as never,
      scopeResolver: fakeResolver([
        { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
        { key: 'ABC-2', created: '2026-08-02T00:00:00.000Z' }
      ]),
      runTurn: async (p) => ({ status: 'ok', text: `did ${p.caseSlug}` }),
      onRunFinished: (info) => finished.push(info),
      now: () => new Date('2026-08-08T02:00:00.000Z')
    })
    svc.startRun('nightly')
    await svc.whenIdle()

    // Exactly the fields service.test.ts's unscoped "reports a finished run once" test asserts
    // against — routineId/routineName/status/summary, sourced from the same RoutineDef either
    // path holds, not a scoped-only shape.
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({
      routineId: 'nightly',
      routineName: 'Nightly',
      status: 'ok',
      summary: '2 processed'
    })
    expect(finished[0].runId).toBe(svc.payload().runs[0].id)
    expect(finished[0].error).toBeUndefined()
  })

  it('announces the saturated / frozen-cursor branch — the shape this feature exists to make loud', async () => {
    // Twelve issues at maxItemsPerRun:2 plus the ten-row CURSOR_BOUNDARY_SLACK is exactly one
    // full window (mirrors the fixture in "a jira-jql window that yields nothing" above).
    const twelve = Array.from({ length: 12 }, (_, n) => ({
      key: `ABC-${n + 1}`,
      created: `2026-08-03T15:${String(n + 30).padStart(2, '0')}:00.000+0200`
    }))
    const cursorBlindResolver: ScopeResolver = {
      resolveJql: async (_jql, _f, _cursor, limit) =>
        twelve.slice(0, limit).map((i) => ({ key: i.key, cursorValue: i.created })),
      ingestJiraItem: async (key: string) => {
        const existing = findCaseByJiraKey(db, key)
        if (existing) return { caseSlug: existing.slug, created: false }
        const slug = key.toLowerCase()
        createCase(db, tmp, { slug, title: key, jiraKey: key })
        return { caseSlug: slug, created: true }
      }
    }
    const finished: RoutineRunFinished[] = []
    const svc = new RoutinesService({
      db,
      argusHome: tmp,
      store: storeOf(routine({ maxItemsPerRun: 2 })) as never,
      scopeResolver: cursorBlindResolver,
      runTurn: async (p) => ({ status: 'ok', text: `did ${p.caseSlug}` }),
      onRunFinished: (info) => finished.push(info),
      now: () => new Date('2026-08-08T02:00:00.000Z')
    })
    // Six runs at two items each attempt all twelve; the seventh saturates.
    for (let i = 0; i < 6; i++) {
      svc.startRun('nightly')
      await svc.whenIdle()
    }
    finished.length = 0

    svc.startRun('nightly')
    await svc.whenIdle()

    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ routineId: 'nightly', status: 'failed' })
    expect(finished[0].error).toMatch(/cursor cannot advance/)
  })

  it('announces a run cut short by quit mid-loop, not just ones that finish on their own terms', async () => {
    const finished: RoutineRunFinished[] = []
    const started: string[] = []
    const svc = new RoutinesService({
      db,
      argusHome: tmp,
      store: storeOf(routine({ maxItemsPerRun: 5 })) as never,
      scopeResolver: fakeResolver([
        { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z' },
        { key: 'ABC-2', created: '2026-08-02T00:00:00.000Z' }
      ]),
      runTurn: (p) =>
        new Promise((resolve) => {
          started.push(p.caseSlug)
          p.signal?.addEventListener(
            'abort',
            () =>
              resolve({ status: 'failed', text: '', error: 'turn aborted: the app is quitting' }),
            { once: true }
          )
        }),
      onRunFinished: (info) => finished.push(info),
      now: () => new Date('2026-08-08T02:00:00.000Z')
    })

    svc.startRun('nightly')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['abc-1'])

    svc.stopForQuit()
    await svc.whenIdle()

    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ routineId: 'nightly', status: 'failed' })
    expect(finished[0].error).toMatch(/quit/i)
  })

  it('announces a run that failed during scope resolution, before any item was ever opened', async () => {
    const finished: RoutineRunFinished[] = []
    const svc = new RoutinesService({
      db,
      argusHome: tmp,
      store: storeOf(routine()) as never,
      scopeResolver: {
        resolveJql: async () => {
          throw new Error('JQL is invalid')
        },
        ingestJiraItem: async () => ({ caseSlug: 'x', created: true })
      },
      runTurn: async () => ({ status: 'ok', text: '' }),
      onRunFinished: (info) => finished.push(info),
      now: () => new Date('2026-08-08T02:00:00.000Z')
    })
    svc.startRun('nightly')
    await svc.whenIdle()

    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ routineId: 'nightly', status: 'failed' })
    expect(finished[0].error).toContain('JQL is invalid')
    expect(finished[0].summary).toBeUndefined()
  })
})
