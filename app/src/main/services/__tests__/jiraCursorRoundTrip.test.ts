import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase, getCase } from '../caseService'
import { buildJiraScopeResolver } from '../jiraScopeResolver'
import { RoutinesService } from '../routines/service'
import { readRoutineCursor } from '../routines/cursors'
import type { AtlassianClient } from '../atlassian'
import type { JiraCases } from '../jiraCases'
import type { RoutineDef } from '../../../shared/routines'

/**
 * THE OFFSET'S ROUND TRIP, END TO END — the one thing the D3 fix rests on.
 *
 * `jiraDate` formats the cursor in the offset the cursor itself carries, which is only correct if
 * that offset is still there by the time the cursor is read back. It travels a long way for a
 * string: out of a Jira search response, into `ResolvedItem.cursorValue`, through the run loop,
 * into the `routine_cursors` table, back out of `readRoutineCursor`, and into the next run's JQL
 * literal. Any step that parsed it into a `Date` — or normalised it to UTC, or dropped the suffix
 * — would silently restore exactly the broken behaviour this fix replaced, and every unit test of
 * the formatter would still pass.
 *
 * So this drives the REAL resolver, the REAL service, the REAL cursor table and the REAL SQLite
 * column, with only the network and the agent turn faked, and asserts the offset at both ends.
 *
 * The fixtures are verbatim from the live run against a real Jira instance: KAN-4/KAN-5's
 * `created` values on a UTC+2 account.
 */

let tmp: string
let db: DatabaseSync

/** Exactly as the live instance returned them, offsets included. */
const KAN4 = '2026-08-03T15:32:34.278+0200'
const KAN5 = '2026-08-03T15:35:25.491+0200'

const routine: RoutineDef = {
  id: 'jira-gate',
  name: 'Jira gate',
  prompt: 'triage it',
  timeoutMs: 600_000,
  enabled: true,
  scope: { kind: 'jira-jql', jql: 'project = KAN', cursorField: 'created' },
  maxItemsPerRun: 1
} as RoutineDef

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-cursor-'))
  db = openDb(path.join(tmp, 'a.sqlite'))
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * Stands in for the network only. It returns the search page shape the live run captured
 * verbatim, and records every JQL string it is handed so the composed cursor bound can be read
 * back out.
 */
function fakeSearch(jqls: string[]): Pick<AtlassianClient, 'searchIssues'> {
  return {
    searchIssues: async (jql: string) => {
      jqls.push(jql)
      return {
        issues: [
          { key: 'KAN-4', created: KAN4, updated: KAN4 },
          { key: 'KAN-5', created: KAN5, updated: KAN5 }
        ],
        nextPageToken: null
      }
    }
  }
}

/** Creates a real case row, minus the ticket fetch. */
const fakeJiraCases: Pick<JiraCases, 'createFromTicket'> = {
  createFromTicket: async ({ slug, title, key }) => {
    createCase(db, tmp, { slug, title, jiraKey: key })
    return getCase(db, slug)!
  }
}

const build = (jqls: string[]): RoutinesService =>
  new RoutinesService({
    db,
    argusHome: tmp,
    store: {
      list: () => [routine],
      get: (id: string) => (id === routine.id ? routine : undefined),
      loadError: () => null
    } as never,
    scopeResolver: buildJiraScopeResolver({
      db,
      atlassian: fakeSearch(jqls),
      jiraCases: fakeJiraCases
    }),
    runTurn: async () => ({ status: 'ok' as const, text: 'done' }),
    now: () => new Date('2026-08-09T12:00:00.000Z')
  })

describe("a Jira cursor's timezone offset", () => {
  it('survives intact from the search response into routine_cursors', async () => {
    const svc = build([])
    svc.startRun('jira-gate')
    await svc.whenIdle()

    // Byte-for-byte, offset and all. Not an ISO string "equivalent to" it: `+0200` normalised to
    // `Z` here would be the whole defect, silently.
    expect(readRoutineCursor(db, 'jira-gate')).toBe(KAN4)
  })

  it("is what the NEXT run's JQL literal is built from, not UTC", async () => {
    const jqls: string[] = []
    const svc = build(jqls)
    svc.startRun('jira-gate')
    await svc.whenIdle()
    svc.startRun('jira-gate')
    await svc.whenIdle()

    expect(jqls).toHaveLength(2)
    // Run 1 is unbounded — there was no cursor yet.
    expect(jqls[0]).toBe('project = KAN ORDER BY created ASC')
    // Run 2 carries the account's own wall clock, which is the only thing Jira will read the
    // literal as. 13:32 is the same instant in UTC and is what the previous implementation
    // produced; against this account it bounds two hours early and re-fetches attempted keys
    // until the window saturates and the routine stalls.
    expect(jqls[1]).toContain('created >= "2026-08-03 15:32"')
    expect(jqls[1]).not.toContain('13:32')
  })
})
