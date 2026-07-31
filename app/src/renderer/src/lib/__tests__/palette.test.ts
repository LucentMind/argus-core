import { describe, expect, it } from 'vitest'
import { corpusRows, draftRows, modeFromQuery, rankAssets, rankCommands } from '../palette'
import type { CorpusItem } from '../../../../shared/corpusSearch'
import type { DraftRecord } from '../../../../shared/editorIpc'
import type { Command } from '../commands'

const CORPUS: CorpusItem[] = [
  {
    kind: 'skill',
    name: 'triage',
    title: '',
    description: 'Triage an incoming case',
    tier: 'user'
  },
  { kind: 'reference', name: 'jira-fields.md', title: 'Jira fields', description: '', tier: null }
]

const draft = (over: Partial<DraftRecord>): DraftRecord => ({
  kind: 'skill',
  name: 'x',
  mode: 'create',
  content: '',
  baseHash: null,
  updatedAt: '2026-07-30T10:00:00.000Z',
  ...over
})

describe('modeFromQuery', () => {
  it('defaults to assets', () => {
    expect(modeFromQuery('jira')).toEqual({ mode: 'assets', query: 'jira' })
  })

  it('switches to commands on a leading >', () => {
    expect(modeFromQuery('>save')).toEqual({ mode: 'commands', query: 'save' })
  })

  it('treats a bare > as commands with no filter', () => {
    expect(modeFromQuery('>')).toEqual({ mode: 'commands', query: '' })
  })

  it('eats one space after the >, so "> save" is not a query of " save"', () => {
    expect(modeFromQuery('> save')).toEqual({ mode: 'commands', query: 'save' })
  })

  it('only treats a LEADING > as the switch', () => {
    expect(modeFromQuery('a>b')).toEqual({ mode: 'assets', query: 'a>b' })
  })
})

describe('corpusRows', () => {
  it('carries kind, tier and a stable id', () => {
    expect(corpusRows(CORPUS)).toEqual([
      {
        id: 'skill:triage',
        kind: 'skill',
        name: 'triage',
        title: '',
        description: 'Triage an incoming case',
        tier: 'user'
      },
      {
        id: 'reference:jira-fields.md',
        kind: 'reference',
        name: 'jira-fields.md',
        title: 'Jira fields',
        description: '',
        tier: null
      }
    ])
  })
})

describe('draftRows', () => {
  it('always offers a create-mode draft — it has no asset to open instead', () => {
    const rows = draftRows([draft({ name: 'new-thing', draftId: 'd1' })], CORPUS)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.draft).toEqual({
      draftId: 'd1',
      kind: 'skill',
      mode: 'create',
      updatedAt: '2026-07-30T10:00:00.000Z'
    })
  })

  it('hides an edit-mode draft whose asset still exists — open the asset, not the draft', () => {
    const rows = draftRows([draft({ kind: 'skill', name: 'triage', mode: 'edit' })], CORPUS)
    expect(rows).toEqual([])
  })

  it('offers an edit-mode draft whose asset is gone — that is the orphan §4.5 keeps', () => {
    const rows = draftRows([draft({ kind: 'skill', name: 'deleted', mode: 'edit' })], CORPUS)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('draft:skill:deleted')
  })

  it('keys a create draft on its draftId, so two drafts sharing a name both appear', () => {
    const rows = draftRows(
      [draft({ name: 'same', draftId: 'a' }), draft({ name: 'same', draftId: 'b' })],
      CORPUS
    )
    expect(rows.map((r) => r.id)).toEqual(['draft:a', 'draft:b'])
  })

  it('puts the most recent draft first', () => {
    const rows = draftRows(
      [
        draft({ name: 'old', draftId: 'a', updatedAt: '2026-07-01T00:00:00.000Z' }),
        draft({ name: 'new', draftId: 'b', updatedAt: '2026-07-30T00:00:00.000Z' })
      ],
      CORPUS
    )
    expect(rows.map((r) => r.name)).toEqual(['new', 'old'])
  })
})

describe('rankAssets', () => {
  const rows = [
    ...corpusRows(CORPUS),
    ...draftRows([draft({ name: 'jira-draft', draftId: 'd' })], CORPUS)
  ]

  it('returns everything, in a stable order, for an empty query', () => {
    expect(rankAssets(rows, '')).toHaveLength(3)
  })

  it('drops rows that do not match', () => {
    expect(rankAssets(rows, 'zzz')).toEqual([])
  })

  it('matches a skill on its description as well as its name', () => {
    expect(rankAssets(rows, 'incoming').map((r) => r.name)).toEqual(['triage'])
  })

  it('matches a reference on its frontmatter title', () => {
    expect(rankAssets(rows, 'Jira fields').map((r) => r.name)).toEqual(['jira-fields.md'])
  })

  it('ranks a name hit above a description hit', () => {
    const only = [
      { ...corpusRows(CORPUS)[0]!, name: 'zzz', description: 'triage' },
      corpusRows(CORPUS)[0]!
    ]
    expect(rankAssets(only, 'triage')[0]!.name).toBe('triage')
  })

  it('always keeps drafts last, however well they score', () => {
    // 'jira' is a better literal match on the draft's name than on the reference's.
    expect(rankAssets(rows, 'jira').map((r) => r.kind)).toEqual(['reference', 'draft'])
  })

  it('ranks a name hit above a title-only hit even when both raw scores are negative', () => {
    // Reproduces the reviewer's finding empirically: query 'z' against 'mmmmmmmmmmz' scores -4
    // (a late, non-boundary match whose lead-in penalty outweighs its bonuses). Multiplying that
    // -4 by the old SECONDARY factor moved it toward zero, so a title-only hit outranked a
    // name hit. With no multiplier, both rows raw-score -4, and only the explicit name-matched
    // priority keeps the name hit on top.
    const nameHit = { ...corpusRows(CORPUS)[0]!, name: 'mmmmmmmmmmz', title: '', description: '' }
    const titleHit = {
      ...corpusRows(CORPUS)[1]!,
      name: 'no-such-letter',
      title: 'mmmmmmmmmmz',
      description: ''
    }
    expect(rankAssets([titleHit, nameHit], 'z').map((r) => r.name)).toEqual([
      'mmmmmmmmmmz',
      'no-such-letter'
    ])
  })
})

describe('rankCommands', () => {
  const cmds: Command[] = [
    { id: 'save', title: 'Save', section: 'File', enabled: true, run: () => {} },
    { id: 'saveAll', title: 'Save all', section: 'File', enabled: false, run: () => {} },
    { id: 'quickOpen', title: 'Open…', section: 'Go', enabled: true, run: () => {} }
  ]

  it('returns everything for an empty query, order untouched', () => {
    expect(rankCommands(cmds, '').map((c) => c.id)).toEqual(['save', 'saveAll', 'quickOpen'])
  })

  it('keeps DISABLED commands in the list', () => {
    // They are shown greyed rather than hidden: a user looking for Save all needs to learn that
    // it exists and why it is unavailable, not that it does not exist.
    expect(rankCommands(cmds, 'save').map((c) => c.id)).toEqual(['save', 'saveAll'])
  })

  it('filters on the title', () => {
    expect(rankCommands(cmds, 'open').map((c) => c.id)).toEqual(['quickOpen'])
  })
})
