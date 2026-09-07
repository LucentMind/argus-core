import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import {
  writeProposal,
  deleteProposal,
  rejectProposal,
  listProposals,
  setProposalsChangedNotifier
} from '../../proposals'
import { stageDistillOutput } from '../staging'
import { assembleDistillInput } from '../input'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'case-a', title: 'A' })
  createCase(db, home, { slug: 'case-b', title: 'B' })
})
afterEach(() => {
  setProposalsChangedNotifier(() => {})
})

const ITEM = {
  type: 'reference-edit' as const,
  target: 'seen-topic',
  title: 'Seen topic',
  content: 'c2',
  basis: 'evidence about the seen topic, long enough for the basis gate'
}

describe('a deleted proposal leaves no trace for the distiller', () => {
  it('is absent from alreadyCaptured (a rejected sibling is present, for contrast)', () => {
    const gone = writeProposal(home, 'case-a', {
      type: 'reference-edit',
      target: 'seen-topic',
      title: 'Seen topic',
      content: 'x'
    })
    const kept = writeProposal(home, 'case-a', {
      type: 'reference-edit',
      target: 'other-topic',
      title: 'Other',
      content: 'y'
    })
    rejectProposal(home, kept, { tag: 'wrong' })
    deleteProposal(home, gone)
    const input = assembleDistillInput(db, home, 'case-a')
    expect(input.alreadyCaptured.proposals).toEqual([
      { type: 'reference-edit', target: 'other-topic', title: 'Other', state: 'rejected' }
    ])
  })

  it('a same-case re-proposal stages fresh: no previously_reviewed, no prior_reject_*', () => {
    const gone = writeProposal(home, 'case-a', {
      type: 'reference-edit',
      target: 'seen-topic',
      title: 'Seen topic',
      content: 'x'
    })
    deleteProposal(home, gone)
    const res = stageDistillOutput(db, home, 'case-a', 9, { proposals: [ITEM] })
    expect(res.staged).toBe(1)
    expect(res.droppedDuplicates).toBe(0)
    const [p] = listProposals(home)
    expect(p.target).toBe('seen-topic')
    expect(p.previouslyReviewed).toBeUndefined()
    expect(p.priorReject).toBeUndefined()
    const raw = fs.readFileSync(path.join(home, 'proposals', p.file), 'utf8')
    expect(raw).not.toContain('previously_reviewed')
    expect(raw).not.toContain('prior_reject')
  })

  it('a cross-case re-proposal carries no prior_reject stamp either', () => {
    const gone = writeProposal(home, 'case-a', {
      type: 'reference-edit',
      target: 'seen-topic',
      title: 'Seen topic',
      content: 'x'
    })
    deleteProposal(home, gone)
    stageDistillOutput(db, home, 'case-b', 10, { proposals: [ITEM] })
    const [p] = listProposals(home)
    expect(p.caseSlug).toBe('case-b')
    expect(p.priorReject).toBeUndefined()
  })

  it('the skills/references index carries no rejection note for the deleted target', () => {
    fs.mkdirSync(path.join(home, 'references'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'references', 'seen-topic.md'),
      '---\ntier: team-knowledge\n---\n# seen topic\n'
    )
    const gone = writeProposal(home, 'case-a', {
      type: 'reference-edit',
      target: 'seen-topic',
      title: 'Seen topic',
      content: 'x'
    })
    deleteProposal(home, gone)
    const input = assembleDistillInput(db, home, 'case-b')
    const entry = input.referencesIndex.find((r) => r.name === 'seen-topic')
    expect(entry).toBeDefined()
    expect((entry as { note?: string }).note).toBeUndefined()
  })
})
