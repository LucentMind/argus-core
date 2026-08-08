import { DEFAULT_ITEMS_PER_RUN, type RoutineTemplate } from '../../../shared/routines'

export type { RoutineTemplate }

/**
 * Pre-filled routines the user adopts and edits through "New from template" (parent spec §7).
 *
 * DATA, not a seeding side effect. Nothing is written to config/routines.json until the user
 * saves: that file is hand-editable and fs-watched, so writing to it unasked would churn the
 * file, re-fire the watcher, race the user's own edits, and require an "already seeded" marker
 * to avoid resurrecting a template the user deleted.
 *
 * Clean like the rest of this directory: no Electron runtime, no Jira client import — this
 * module is pure data, importable from a Vitest run or a renderer test with nothing to stub.
 */

/**
 * The JQL IS EMPTY ON PURPOSE and the editor must block save until it is filled in.
 *
 * The alternative is shipping a placeholder project key, which is either a literal "TBD" in
 * production data or a routine that queries a project that does not exist — and which would
 * still be scheduled nightly against nothing. `routineSchema` refuses to parse this draft as-is
 * (`scopeSchema`'s `jira-jql` variant requires `jql.min(1)`) — that failure is the property the
 * editor's save guard relies on, not a bug to work around.
 */
export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = [
  {
    id: 'pre-triage',
    name: 'Pre-triage',
    description:
      'Overnight: fetch each new ticket, dup-check it against the known-defects corpus, record findings, and propose a title and tags for review.',
    draft: {
      name: 'Pre-triage',
      scope: { kind: 'jira-jql', jql: '', cursorField: 'created' },
      maxItemsPerRun: DEFAULT_ITEMS_PER_RUN,
      schedule: { kind: 'daily', at: '02:00' },
      timeoutMs: 900_000,
      enabled: true,
      prompt: [
        'You are pre-triaging one defect ticket. Its evidence has already been fetched into this case — you do not have Jira access and do not need it.',
        '',
        '1. Read the ticket and its attachments with list_evidence and search_evidence.',
        '2. Run search_known_defects on the clearest symptom, then again on any stack-trace or error signature you find. Say plainly whether this looks like a duplicate and of what.',
        '3. Record what you concluded with append_finding, citing evidence as [relPath:line].',
        '4. Finish with propose_case_triage: a tighter title, and tags for severity (severity:high|medium|low), component (component:<area>) and, only if the evidence names one, owner (owner:<name>).',
        '',
        'Propose, do not decide. A human accepts or dismisses everything you suggest.'
      ].join('\n')
    }
  }
]
