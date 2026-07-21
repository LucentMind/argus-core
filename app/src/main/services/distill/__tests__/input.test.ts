import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, setCaseStatus } from '../../caseService'
import { applyMemoryWrite } from '../../memory'
import { writeProposal, rejectProposal } from '../../proposals'
import { assembleDistillInput, buildReferencesIndex } from '../input'
import { sharedReferencesDir } from '../../skillsDir'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'case-a', title: 'DLT drift', jiraKey: 'AB-1' })
})

describe('assembleDistillInput', () => {
  it('collects meta, findings with review states, and already-captured knowledge', () => {
    // seed one finding row + body marker
    const caseId = (db.prepare(`SELECT id FROM cases WHERE slug='case-a'`).get() as { id: number })
      .id
    const r = db
      .prepare(
        `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at)
       VALUES (?, NULL, NULL, 'Root cause found', 'accepted', '2026-07-16T00:00:00Z')`
      )
      .run(caseId)
    fs.appendFileSync(
      path.join(home, 'cases', 'case-a', 'findings.md'),
      `\n<!-- finding:${Number(r.lastInsertRowid)} -->\n## Root cause found\n\nClock resync.\n`
    )
    // in-case knowledge: one memory write + one rejected proposal
    applyMemoryWrite(home, 'case-a', { topic: 'dlt-timing', content: 'fact', indexEntry: 'entry' })
    const pf = writeProposal(home, 'case-a', {
      type: 'recipe',
      target: 'dlt-cmds',
      title: 'Cmds',
      content: 'x'
    })
    rejectProposal(home, pf)
    setCaseStatus(db, home, 'case-a', 'closed', 'solved')

    const input = assembleDistillInput(db, home, 'case-a', [
      {
        name: 'analyze-dlt',
        description: 'DLT skill',
        content: '---\nname: analyze-dlt\n---\nbody'
      }
    ])
    expect(input.caseMeta).toMatchObject({ slug: 'case-a', jiraKey: 'AB-1', resolution: 'solved' })
    expect(input.findings).toEqual([
      {
        summary: 'Root cause found',
        reviewState: 'accepted',
        body: expect.stringContaining('Clock resync.')
      }
    ])
    expect(input.skillsIndex).toEqual([
      {
        name: 'analyze-dlt',
        description: 'DLT skill',
        content: '---\nname: analyze-dlt\n---\nbody'
      }
    ])
    expect(input.alreadyCaptured.memoryWrites).toEqual([
      { topic: 'dlt-timing', indexEntry: 'entry' }
    ])
    expect(input.alreadyCaptured.proposals).toEqual([
      { type: 'recipe', target: 'dlt-cmds', title: 'Cmds', state: 'rejected' }
    ])
    expect(input.memoryIndex).toContain('dlt-timing')
  })

  it('throws on unknown case', () => {
    expect(() => assembleDistillInput(db, home, 'nope')).toThrow(/Unknown case/)
  })
})

describe('buildReferencesIndex', () => {
  it('summarizes from the body paragraph, falling back to the title only when no body line exists', () => {
    const dir = sharedReferencesDir(home)
    fs.mkdirSync(dir, { recursive: true })
    // 1. Titled file whose body has a real paragraph line — summary is that
    //    paragraph, not a duplicate of the title.
    fs.writeFileSync(
      path.join(dir, 'titled.md'),
      '---\ntitle: DLT Drift Runbook\ntrust_tier: team-knowledge\n---\n\nRun the resync script before escalating.\n\nMore detail below.\n'
    )
    // 2. Untitled-summary case: content after frontmatter starts with a blank
    //    line, then a heading, then a paragraph — summary is the paragraph.
    fs.writeFileSync(
      path.join(dir, 'heading-first.md'),
      '---\ntitle: Heading First\ntrust_tier: team-knowledge\n---\n\n# Heading\n\nThe actual useful summary line.\n'
    )
    // 3. Only a heading and nothing else — falls back to the title text.
    fs.writeFileSync(
      path.join(dir, 'only-heading.md'),
      '---\ntitle: Only Heading Title\ntrust_tier: team-knowledge\n---\n\n# Just A Heading\n'
    )

    const index = buildReferencesIndex(home)
    expect(index).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'titled',
          summary: 'Run the resync script before escalating.'
        }),
        expect.objectContaining({
          name: 'heading-first',
          summary: 'The actual useful summary line.'
        }),
        expect.objectContaining({ name: 'only-heading', summary: 'Only Heading Title' })
      ])
    )
  })

  it('carries the full reference file content so a reference-edit can merge into it', () => {
    const dir = sharedReferencesDir(home)
    fs.mkdirSync(dir, { recursive: true })
    const raw = '---\ntitle: DLT Drift Runbook\ntrust_tier: team-knowledge\n---\n\nResync first.\n'
    fs.writeFileSync(path.join(dir, 'titled.md'), raw)

    const entry = buildReferencesIndex(home).find((r) => r.name === 'titled')
    expect(entry?.content).toBe(raw)
  })
})
