import { describe, expect, it } from 'vitest'
import { ROUTINE_TEMPLATES } from '../templates'
import { routineSchema, DEFAULT_ITEMS_PER_RUN } from '../../../../shared/routines'

describe('routine templates', () => {
  it('ships exactly one template today: pre-triage', () => {
    expect(ROUTINE_TEMPLATES.map((t) => t.id)).toEqual(['pre-triage'])
  })

  it('leaves the JQL EMPTY so no template ever ships a placeholder project key', () => {
    const t = ROUTINE_TEMPLATES[0]
    expect(t.draft.scope).toEqual({ kind: 'jira-jql', jql: '', cursorField: 'created' })
  })

  it('is NOT parseable as a routine until the user fills the jql in', () => {
    // This is the property the editor's save guard relies on.
    expect(() => routineSchema.parse({ id: 'x', ...ROUTINE_TEMPLATES[0].draft })).toThrow()
  })

  it('becomes valid the moment a real jql is supplied', () => {
    const t = ROUTINE_TEMPLATES[0]
    const filled = {
      id: 'pre-triage',
      ...t.draft,
      // Non-null: the previous test already establishes t.draft.scope exists.
      scope: { ...t.draft.scope!, jql: 'project = ABC AND status = "To Do"' }
    }
    expect(() => routineSchema.parse(filled)).not.toThrow()
  })

  it('pre-fills a conservative cap and a nightly schedule', () => {
    const t = ROUTINE_TEMPLATES[0]
    expect(t.draft.maxItemsPerRun).toBe(DEFAULT_ITEMS_PER_RUN)
    expect(t.draft.schedule).toEqual({ kind: 'daily', at: '02:00' })
  })

  it('tells the model to dup-check and to end with propose_case_triage', () => {
    const p = ROUTINE_TEMPLATES[0].draft.prompt!
    expect(p).toMatch(/search_known_defects/)
    expect(p).toMatch(/propose_case_triage/)
    expect(p).toMatch(/append_finding/)
  })
})
