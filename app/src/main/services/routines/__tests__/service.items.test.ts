import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { RoutinesService, type RoutineTurnRequest } from '../service'
import { listRunItems, runItemForCase } from '../runItems'
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
      const slug = key.toLowerCase()
      if (!getCase(db, slug)) createCase(db, tmp, { slug, title: key })
      return { caseSlug: slug }
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

  it('records a failed run when the scope itself cannot be resolved', async () => {
    const svc = new RoutinesService({
      db,
      argusHome: tmp,
      store: storeOf(routine()) as never,
      scopeResolver: {
        resolveJql: async () => {
          throw new Error('JQL is invalid')
        },
        ingestJiraItem: async () => ({ caseSlug: 'x' })
      },
      runTurn: async () => ({ status: 'ok', text: '' }),
      now: () => new Date('2026-08-08T02:00:00.000Z')
    })
    svc.startRun('nightly')
    await svc.whenIdle()
    const run = svc.payload().runs[0]
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/JQL is invalid/)
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
})
