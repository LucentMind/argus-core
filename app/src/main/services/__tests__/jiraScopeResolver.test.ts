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

/** Captures the exact JQL string (and options) the resolver hands to `searchIssues`. */
function fakeAtlassian(
  page: JiraSearchPage,
  capture: { jql?: string; opts?: { maxResults?: number } } = {}
): Pick<AtlassianClient, 'searchIssues'> {
  return {
    searchIssues: async (jql: string, opts: { maxResults?: number; pageToken?: string }) => {
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
