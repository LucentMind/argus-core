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
  /**
   * `accountTimeZone` as well as `searchIssues`: the cursor bound is a JQL date literal, which
   * Jira evaluates in the searching account's timezone, so composing the query needs both. The
   * client caches the zone per instance — this resolver must not (see resolveJql).
   */
  atlassian: Pick<AtlassianClient, 'searchIssues' | 'accountTimeZone'>
  jiraCases: Pick<JiraCases, 'createFromTicket'>
}

/**
 * Replaces the contents of every quoted JQL string literal with `_` (one-for-one, so positions
 * and length are preserved) while leaving quote delimiters and everything outside quotes intact.
 *
 * JQL literals may be single- or double-quoted, and a quote can be escaped with a backslash
 * inside its own literal (`"say \"hi\""`). A naive quote-toggle scanner would flip state on that
 * escaped quote and lose track of where the literal actually ends; this walks the string once,
 * tracking which quote character (if any) is currently open, and treats a backslash inside a
 * quote as consuming the next character rather than ending the literal.
 */
function maskJqlStringLiterals(jql: string): string {
  let masked = ''
  let openQuote: '"' | "'" | null = null
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i]
    if (openQuote) {
      if (ch === '\\' && i + 1 < jql.length) {
        masked += '__'
        i++
        continue
      }
      if (ch === openQuote) {
        openQuote = null
        masked += ch
        continue
      }
      masked += '_'
      continue
    }
    if (ch === '"' || ch === "'") {
      openQuote = ch
      masked += ch
      continue
    }
    masked += ch
  }
  return masked
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
 *
 * The clause must be found OUTSIDE any quoted string literal: `text ~ "please order by end of
 * day"` contains the literal text "order by" but has no real trailing clause, and must survive
 * untouched. `maskJqlStringLiterals` blanks out literal contents (preserving every other
 * character's position) so the same whitespace/order/by pattern can be matched against the masked
 * copy, then used to slice the real string.
 */
function stripTrailingOrderBy(jql: string): string {
  const match = maskJqlStringLiterals(jql).match(/\s+order\s+by\s+.+$/i)
  if (!match || match.index === undefined) return jql.trim()
  return jql.slice(0, match.index).trim()
}

export function buildJiraScopeResolver(deps: JiraScopeResolverDeps): ScopeResolver {
  const { db, atlassian, jiraCases } = deps
  return {
    async resolveJql(jql, cursorField, cursor, limit) {
      const base = stripTrailingOrderBy(jql)
      // `>=` on the cursor is deliberate and items.ts depends on it: Jira timestamps are not
      // unique, so a strict `>` drops one of two tickets sharing a minute, permanently and
      // silently. The duplicate is removed by key, not by tightening this comparison.
      //
      // The literal is formatted in the ACCOUNT's timezone, because that is the only zone JQL
      // will read it in (see jiraDate). Asked for only when there IS a cursor — an unbounded
      // first run needs no literal, so a brand-new routine costs no extra request — and answered
      // from the client's per-instance cache on every run after the first, so this is not a
      // per-query fetch.
      const zone = cursor ? await atlassian.accountTimeZone() : null
      const bounded = cursor ? `(${base}) AND ${cursorField} >= "${jiraDate(cursor, zone)}"` : base
      const page = await atlassian.searchIssues(`${bounded} ORDER BY ${cursorField} ASC`, {
        maxResults: limit
      })
      // An issue whose `fields` block was missing arrives with an EMPTY cursor value
      // (atlassian.ts). Skipping it here is the whole guard: attempting it would write '' as the
      // routine's cursor, `readRoutineCursor` would hand that back, `cursor ? ... : base` above
      // reads it as FALSY, and the next run would query the project unbounded from its very
      // beginning — where every result is already in `attemptedItemKeys`, so the run selects
      // nothing, reports `ok`, and the routine is stalled permanently and silently. One item is
      // a far cheaper loss than the routine, and the reason is logged rather than swallowed.
      // `writeRoutineCursor` (routines/cursors.ts) refuses a falsy value outright, so a future
      // resolver that forgets this filter fails loudly instead of resetting the cursor.
      const usable = page.issues.filter((i) => i[cursorField].trim() !== '')
      if (usable.length !== page.issues.length) {
        const dropped = page.issues.filter((i) => i[cursorField].trim() === '').map((i) => i.key)
        console.warn(
          `[routines] skipped ${dropped.length} issue(s) with no usable ${cursorField} value ` +
            `(${dropped.join(', ')}) — they would reset this routine's cursor`
        )
      }
      return usable.map((i) => ({ key: i.key, cursorValue: i[cursorField] }))
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
