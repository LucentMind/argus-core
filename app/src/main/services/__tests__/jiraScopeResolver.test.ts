import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { buildJiraScopeResolver } from '../jiraScopeResolver'
import type { AtlassianClient, JiraSearchPage } from '../atlassian'
import type { JiraCases } from '../jiraCases'
import type { CaseRecord } from '../../../shared/types'

/**
 * Real behavioural coverage for the Jira half of ScopeResolver, extracted out of `main/index.ts`
 * (Task 12 review, Important 1) specifically so it stops being covered ONLY by assertions on
 * `index.ts`'s source text. A fake `searchIssues`, a real sqlite db (via `openDb`), and a fake
 * `jiraCases.createFromTicket` are enough to exercise every branch without Electron.
 */

let tmp: string
let db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-scope-resolver-'))
  db = openDb(path.join(tmp, 'a.sqlite'))
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * Captures the exact JQL string (and options) the resolver hands to `searchIssues`.
 *
 * `searchIssues` is the ONLY method this resolver needs. The cursor bound's timezone used to come
 * from a second call (`/rest/api/3/myself`); it now comes out of the cursor string itself, so a
 * fake that only searches is the whole surface.
 */
function fakeAtlassian(
  page: JiraSearchPage,
  capture: { jql?: string; opts?: { maxResults?: number }; searches?: number } = {}
): Pick<AtlassianClient, 'searchIssues'> {
  capture.searches = 0
  return {
    searchIssues: async (jql: string, opts: { maxResults?: number; pageToken?: string }) => {
      capture.searches = (capture.searches ?? 0) + 1
      capture.jql = jql
      capture.opts = opts
      return page
    }
  }
}

const noCreate: Pick<JiraCases, 'createFromTicket'> = {
  createFromTicket: async () => {
    throw new Error('createFromTicket must not be called on the adopt path')
  }
}

describe('resolveJql', () => {
  it('applies jiraDate to the cursor rather than the raw ISO string', async () => {
    const capture: { jql?: string } = {}
    const resolver = buildJiraScopeResolver({
      db,
      atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
      jiraCases: noCreate
    })
    await resolver.resolveJql('project = ABC', 'created', '2026-08-08T02:15:30.000Z', 10)
    // jiraDate truncates to minute resolution and drops the trailing 'Z' / seconds — a raw ISO
    // string leaking through here means the JQL literal is malformed against a real Jira instance.
    expect(capture.jql).toContain('created >= "2026-08-08 02:15"')
    expect(capture.jql).not.toContain('2026-08-08T02:15:30.000Z')
  })

  /**
   * JQL has no timezone syntax: Jira evaluates a bare date literal as wall-clock time in the
   * SEARCHING ACCOUNT's zone. A cursor formatted in UTC is therefore a bound at the wrong
   * instant by the account's whole offset — west of UTC the bound lands late and those tickets
   * are skipped forever (the cursor only moves forward); east of UTC it lands early and the
   * window fills with already-attempted keys until the routine stalls. Both report `ok`.
   *
   * The cursor the resolver is handed is a value Jira itself produced, so it carries the account's
   * offset. These assert that the offset it carries is what reaches the JQL — with NO second
   * request of any kind, which is what makes the whole thing work on a connector that only holds
   * `read:jira-work`.
   */
  describe("the cursor's own offset", () => {
    const boundedWith = async (cursor: string): Promise<{ jql?: string; searches?: number }> => {
      const capture: { jql?: string; searches?: number } = {}
      const resolver = buildJiraScopeResolver({
        db,
        atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
        jiraCases: noCreate
      })
      await resolver.resolveJql('project = ABC', 'created', cursor, 10)
      return capture
    }

    it('formats the cursor literal in its own offset, west of UTC', async () => {
      // 02:15-0700 is 09:15Z. A UTC literal would bound at 09:15 and skip every ticket filed in
      // those seven hours, permanently.
      const capture = await boundedWith('2026-08-08T02:15:30.000-0700')
      expect(capture.jql).toContain('created >= "2026-08-08 02:15"')
      expect(capture.jql).not.toContain('2026-08-08 09:15')
    })

    it('formats the cursor literal in its own offset, east of UTC', async () => {
      // The live-run shape: a UTC+2 account. A UTC literal would bound two hours early and
      // re-fetch already-attempted keys until the window saturated.
      const capture = await boundedWith('2026-08-03T15:36:14.574+0200')
      expect(capture.jql).toContain('created >= "2026-08-03 15:36"')
      expect(capture.jql).not.toContain('2026-08-03 13:36')
    })

    it('costs exactly one request — the search — and nothing else', async () => {
      const capture = await boundedWith('2026-08-03T15:36:14.574+0200')
      expect(capture.searches).toBe(1)
    })

    it('falls back to a conservative earlier bound for a cursor with no offset at all', async () => {
      const capture = await boundedWith('2026-08-08T02:15:30.000')
      // 12 hours earlier — never LATER than intended for any account on earth, so this path can
      // only re-examine, never skip. See JIRA_CURSOR_UNKNOWN_ZONE_MARGIN_MS for what it costs and
      // why no Jira-produced cursor reaches it.
      expect(capture.jql).toContain('created >= "2026-08-07 14:15"')
    })
  })

  it('uses an INCLUSIVE >= boundary, not a strict >', async () => {
    const capture: { jql?: string } = {}
    const resolver = buildJiraScopeResolver({
      db,
      atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
      jiraCases: noCreate
    })
    await resolver.resolveJql('project = ABC', 'created', '2026-08-08T02:15:30.000Z', 10)
    expect(capture.jql).toMatch(/created >= "/)
    expect(capture.jql).not.toMatch(/created\s*>\s*[^=]/)
  })

  it('orders ascending by the requested cursor field', async () => {
    const capture: { jql?: string } = {}
    const resolver = buildJiraScopeResolver({
      db,
      atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
      jiraCases: noCreate
    })
    await resolver.resolveJql('project = ABC', 'updated', null, 10)
    expect(capture.jql?.trim().endsWith('ORDER BY updated ASC')).toBe(true)
  })

  it('reads cursorValue from the field the scope actually asked for', async () => {
    const page: JiraSearchPage = {
      issues: [
        {
          key: 'ABC-1',
          created: '2026-08-01T00:00:00.000Z',
          updated: '2026-08-05T00:00:00.000Z'
        }
      ],
      nextPageToken: null
    }
    const byCreated = buildJiraScopeResolver({
      db,
      atlassian: fakeAtlassian(page),
      jiraCases: noCreate
    })
    const createdResult = await byCreated.resolveJql('project = ABC', 'created', null, 10)
    expect(createdResult).toEqual([{ key: 'ABC-1', cursorValue: '2026-08-01T00:00:00.000Z' }])

    const byUpdated = buildJiraScopeResolver({
      db,
      atlassian: fakeAtlassian(page),
      jiraCases: noCreate
    })
    const updatedResult = await byUpdated.resolveJql('project = ABC', 'updated', null, 10)
    expect(updatedResult).toEqual([{ key: 'ABC-1', cursorValue: '2026-08-05T00:00:00.000Z' }])
  })

  /**
   * `searchIssues` defaults a missing `fields` block to an empty string. That value passes
   * service.ts's `cursorValue !== null` guard, gets written as the routine's cursor, and reads
   * back FALSY — so the next run drops its bound and queries the project from the beginning,
   * where every result is already in `attemptedItemKeys`: zero items selected, `ok` recorded,
   * routine stalled forever. The item must not enter the run at all.
   */
  describe('an issue with no usable cursor value', () => {
    it('is skipped, and the rest of the page survives', async () => {
      const resolver = buildJiraScopeResolver({
        db,
        atlassian: fakeAtlassian({
          issues: [
            { key: 'ABC-1', created: '2026-08-01T00:00:00.000Z', updated: 'u1' },
            { key: 'ABC-2', created: '', updated: 'u2' },
            { key: 'ABC-3', created: '2026-08-03T00:00:00.000Z', updated: 'u3' }
          ],
          nextPageToken: null
        }),
        jiraCases: noCreate
      })
      const out = await resolver.resolveJql('project = ABC', 'created', null, 10)
      expect(out).toEqual([
        { key: 'ABC-1', cursorValue: '2026-08-01T00:00:00.000Z' },
        { key: 'ABC-3', cursorValue: '2026-08-03T00:00:00.000Z' }
      ])
    })

    it('is judged on the field the scope actually tracks, not on both', async () => {
      // The same issue is fine for a `created` scope and unusable for an `updated` one.
      const page: JiraSearchPage = {
        issues: [{ key: 'ABC-1', created: '2026-08-01T00:00:00.000Z', updated: '' }],
        nextPageToken: null
      }
      const byCreated = buildJiraScopeResolver({
        db,
        atlassian: fakeAtlassian(page),
        jiraCases: noCreate
      })
      expect(await byCreated.resolveJql('project = ABC', 'created', null, 10)).toHaveLength(1)
      const byUpdated = buildJiraScopeResolver({
        db,
        atlassian: fakeAtlassian(page),
        jiraCases: noCreate
      })
      expect(await byUpdated.resolveJql('project = ABC', 'updated', null, 10)).toEqual([])
    })

    it('names the skipped keys in a warning rather than dropping them silently', async () => {
      const warnings: string[] = []
      const warn = console.warn
      console.warn = (...args: unknown[]): void => void warnings.push(args.join(' '))
      try {
        const resolver = buildJiraScopeResolver({
          db,
          atlassian: fakeAtlassian({
            issues: [{ key: 'ABC-2', created: '   ', updated: 'u' }],
            nextPageToken: null
          }),
          jiraCases: noCreate
        })
        await resolver.resolveJql('project = ABC', 'created', null, 10)
      } finally {
        console.warn = warn
      }
      expect(warnings.join('\n')).toMatch(/ABC-2/)
      expect(warnings.join('\n')).toMatch(/cursor/)
    })
  })

  it('passes limit through as maxResults', async () => {
    const capture: { opts?: { maxResults?: number } } = {}
    const resolver = buildJiraScopeResolver({
      db,
      atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
      jiraCases: noCreate
    })
    await resolver.resolveJql('project = ABC', 'created', null, 37)
    expect(capture.opts?.maxResults).toBe(37)
  })

  // Important 2: Jira's own issue navigator appends `ORDER BY created DESC` to every query it
  // builds, so pasting a JQL string that already ends in an ORDER BY is the expected authoring
  // flow, not misuse. The resolver always appends its OWN `ORDER BY <field> ASC` (the cursor
  // depends on ascending order), so without stripping the user's clause first, composing produces
  // two ORDER BY clauses — a JQL syntax error that fails 100% of that routine's runs.
  describe('a user JQL with its own trailing ORDER BY', () => {
    it('is stripped before composing, with no cursor bound', async () => {
      const capture: { jql?: string } = {}
      const resolver = buildJiraScopeResolver({
        db,
        atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
        jiraCases: noCreate
      })
      await resolver.resolveJql('project = ABC   ORDER BY created DESC  ', 'created', null, 10)
      expect(capture.jql).toBe('project = ABC ORDER BY created ASC')
      expect(capture.jql?.match(/order by/gi)).toHaveLength(1)
    })

    it('is stripped case-insensitively, tolerant of whitespace, even with a cursor bound', async () => {
      const capture: { jql?: string } = {}
      const resolver = buildJiraScopeResolver({
        db,
        atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
        jiraCases: noCreate
      })
      await resolver.resolveJql(
        'project = ABC   order by   updated   desc',
        'created',
        '2026-08-01T00:00:00.000Z',
        10
      )
      expect(capture.jql).toBe(
        '(project = ABC) AND created >= "2026-08-01 00:00" ORDER BY created ASC'
      )
      expect(capture.jql?.match(/order by/gi)).toHaveLength(1)
    })

    it('leaves a JQL with no ORDER BY untouched apart from the appended one', async () => {
      const capture: { jql?: string } = {}
      const resolver = buildJiraScopeResolver({
        db,
        atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
        jiraCases: noCreate
      })
      await resolver.resolveJql('project = ABC AND status = Open', 'created', null, 10)
      expect(capture.jql).toBe('project = ABC AND status = Open ORDER BY created ASC')
    })

    it('still strips a multi-key sort completely', async () => {
      const capture: { jql?: string } = {}
      const resolver = buildJiraScopeResolver({
        db,
        atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
        jiraCases: noCreate
      })
      await resolver.resolveJql('project = ABC ORDER BY a ASC, b DESC', 'created', null, 10)
      expect(capture.jql).toBe('project = ABC ORDER BY created ASC')
      expect(capture.jql?.match(/order by/gi)).toHaveLength(1)
    })
  })

  // Important 1 (fix pass 2): the naive strip regex could not tell a real trailing ORDER BY
  // clause from the literal text "order by" sitting inside a quoted JQL string value — it matched
  // at the whitespace before "order" wherever it first appeared, ate to end-of-string, and stripped
  // the closing quote off a value like `text ~ "please order by end of day"`, producing an
  // unterminated string literal (invalid JQL, 100% failure). The strip must only ever treat an
  // ORDER BY as real when it occurs outside a quoted string.
  describe('a quoted JQL value containing the literal text "order by"', () => {
    it('is not mistaken for a trailing clause and the JQL survives intact', async () => {
      const capture: { jql?: string } = {}
      const resolver = buildJiraScopeResolver({
        db,
        atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
        jiraCases: noCreate
      })
      await resolver.resolveJql('text ~ "please order by end of day"', 'created', null, 10)
      expect(capture.jql).toBe('text ~ "please order by end of day" ORDER BY created ASC')
      expect(capture.jql?.match(/order by/gi)).toHaveLength(2) // the literal text, plus the real clause
    })

    it('strips only the real trailing clause, leaving the quoted text untouched', async () => {
      const capture: { jql?: string } = {}
      const resolver = buildJiraScopeResolver({
        db,
        atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
        jiraCases: noCreate
      })
      await resolver.resolveJql(
        'text ~ "please order by end of day" ORDER BY created DESC',
        'created',
        null,
        10
      )
      expect(capture.jql).toBe('text ~ "please order by end of day" ORDER BY created ASC')
      expect(capture.jql?.match(/order by/gi)).toHaveLength(2)
    })

    it('behaves the same for a single-quoted value', async () => {
      const capture: { jql?: string } = {}
      const resolver = buildJiraScopeResolver({
        db,
        atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
        jiraCases: noCreate
      })
      await resolver.resolveJql(
        "text ~ 'please order by end of day' ORDER BY created DESC",
        'created',
        null,
        10
      )
      expect(capture.jql).toBe("text ~ 'please order by end of day' ORDER BY created ASC")
      expect(capture.jql?.match(/order by/gi)).toHaveLength(2)
    })

    it('is not confused by an escaped quote inside the value', async () => {
      // The space before "order" inside the escaped inner quotes matters: a naive regex without
      // quote-tracking would happily match `\s+order\s+by\s+` starting there (there's nothing
      // quote-aware stopping it), eating from mid-literal to end-of-string. Only a scanner that
      // treats the backslash as escaping the following `"` — keeping the literal open across it —
      // avoids that.
      const capture: { jql?: string } = {}
      const resolver = buildJiraScopeResolver({
        db,
        atlassian: fakeAtlassian({ issues: [], nextPageToken: null }, capture),
        jiraCases: noCreate
      })
      await resolver.resolveJql(
        'text ~ "say \\"please order by end of day\\" twice" ORDER BY created DESC',
        'created',
        null,
        10
      )
      expect(capture.jql).toBe(
        'text ~ "say \\"please order by end of day\\" twice" ORDER BY created ASC'
      )
      expect(capture.jql?.match(/order by/gi)).toHaveLength(2)
    })
  })
})

describe('ingestJiraItem', () => {
  it('adopts an existing case (created: false) rather than creating a duplicate', async () => {
    createCase(db, tmp, { slug: 'human-opened', title: 'Human-opened', jiraKey: 'ABC-9' })
    const resolver = buildJiraScopeResolver({
      db,
      atlassian: fakeAtlassian({ issues: [], nextPageToken: null }),
      jiraCases: noCreate
    })
    const result = await resolver.ingestJiraItem('ABC-9')
    expect(result).toEqual({ caseSlug: 'human-opened', created: false })
  })

  it('adopts by jira_key, NOT by the lowercased slug', async () => {
    // The case's slug deliberately does NOT equal key.toLowerCase() — if ingestJiraItem ever
    // regressed to keying adoption off the slug instead of jira_key, this case would be invisible
    // to it and a duplicate would be created (and noCreate would throw, failing the test).
    createCase(db, tmp, { slug: 'renamed-case', title: 'Renamed', jiraKey: 'ABC-42' })
    const resolver = buildJiraScopeResolver({
      db,
      atlassian: fakeAtlassian({ issues: [], nextPageToken: null }),
      jiraCases: noCreate
    })
    const result = await resolver.ingestJiraItem('ABC-42')
    expect(result).toEqual({ caseSlug: 'renamed-case', created: false })
  })

  it('creates a case on a miss (created: true) and never touches an unrelated case', async () => {
    createCase(db, tmp, { slug: 'other-case', title: 'Unrelated', jiraKey: 'ZZZ-1' })
    let createArgs: { slug: string; title: string; key: string } | undefined
    const jiraCases: Pick<JiraCases, 'createFromTicket'> = {
      createFromTicket: async (input) => {
        createArgs = input
        return { slug: input.slug } as CaseRecord
      }
    }
    const resolver = buildJiraScopeResolver({
      db,
      atlassian: fakeAtlassian({ issues: [], nextPageToken: null }),
      jiraCases
    })
    const result = await resolver.ingestJiraItem('XYZ-1')
    expect(result).toEqual({ caseSlug: 'xyz-1', created: true })
    expect(createArgs).toEqual({ slug: 'xyz-1', title: 'XYZ-1', key: 'XYZ-1' })
  })
})
