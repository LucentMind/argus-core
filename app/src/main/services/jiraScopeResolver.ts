import type { DatabaseSync } from 'node:sqlite'
import type { AtlassianClient } from './atlassian'
import { jiraDate } from './atlassian'
import { findCaseByJiraKey } from './caseService'
import type { JiraCases } from './jiraCases'
import type { ScopeResolver } from './routines/scopeResolver'

/**
 * The Jira half of `ScopeResolver`, extracted so it is reachable from Vitest.
 *
 * Lives in `services/`, NOT `services/routines/` — the engine's ban on importing `atlassian.ts`
 * (and `electron`) must stay intact; this file is the one place that ban does not apply, same as
 * it never applied to `main/index.ts`. `index.ts` now just calls this builder and passes the
 * result to `RoutinesService`; none of the JQL-building or adopt/create logic lives there anymore.
 */
export interface JiraScopeResolverDeps {
  db: DatabaseSync
  atlassian: Pick<AtlassianClient, 'searchIssues'>
  jiraCases: Pick<JiraCases, 'createFromTicket'>
}

/**
 * Strips a trailing `ORDER BY ...` clause off a user-authored JQL string.
 *
 * Jira's own issue navigator appends `ORDER BY created DESC` (or similar) to every query it
 * builds, so pasting one in verbatim is the expected authoring flow — not a misuse. `resolveJql`
 * below always appends its OWN `ORDER BY ${cursorField} ASC`, because the cursor depends on
 * ascending order; a second `ORDER BY` clause is a JQL syntax error, so without this strip a
 * pasted query would fail 100% of that routine's runs. The routine's ordering is not negotiable,
 * so silently dropping the user's sort (rather than erroring, or trying to merge the two) is the
 * correct behaviour here — case-insensitive and tolerant of surrounding whitespace, matching how
 * forgiving the navigator's own paste target is.
 */
function stripTrailingOrderBy(jql: string): string {
  return jql.replace(/\s+order\s+by\s+.+$/i, '').trim()
}

export function buildJiraScopeResolver(deps: JiraScopeResolverDeps): ScopeResolver {
  const { db, atlassian, jiraCases } = deps
  return {
    async resolveJql(jql, cursorField, cursor, limit) {
      const base = stripTrailingOrderBy(jql)
      // `>=` on the cursor is deliberate and items.ts depends on it: Jira timestamps are not
      // unique, so a strict `>` drops one of two tickets sharing a minute, permanently and
      // silently. The duplicate is removed by key, not by tightening this comparison.
      const bounded = cursor ? `(${base}) AND ${cursorField} >= "${jiraDate(cursor)}"` : base
      const page = await atlassian.searchIssues(`${bounded} ORDER BY ${cursorField} ASC`, {
        maxResults: limit
      })
      return page.issues.map((i) => ({ key: i.key, cursorValue: i[cursorField] }))
    },
    async ingestJiraItem(key) {
      // ADOPT first: a JQL result whose key already has a case must never get a second one.
      // `jiraCases.createFromTicket` takes a caller-supplied slug and would happily create a
      // duplicate, so pre-triage checks findCaseByJiraKey (which keys off jira_key, NOT the
      // slug) before ever reaching it.
      const existing = findCaseByJiraKey(db, key)
      if (existing) return { caseSlug: existing.slug, created: false }
      const slug = key.toLowerCase()
      const rec = await jiraCases.createFromTicket({ slug, title: key, key })
      return { caseSlug: rec.slug, created: true }
    }
  }
}
