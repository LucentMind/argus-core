import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { addBinding } from '../../prBindings'
import { buildCiTriagePrompt } from '../ciTriage'
import { composeCiTriagePrompt } from '../ciTriageCompose'

let db: DatabaseSync
let home: string

function seedSession(mode: string): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO sessions (id, case_id, mode, created_at, updated_at) VALUES (1, ?, ?, ?, ?)`
  ).run(getCase(db, 'c1')!.id, mode, now, now)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-citriage-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
})

describe('buildCiTriagePrompt', () => {
  it('names the check, the PR and the tool, and forbids a layer', () => {
    const text = buildCiTriagePrompt({
      checkName: 'build',
      prUrl: 'https://github.com/acme/widget/pull/42',
      worktreePath: '/wt/widget-c1-pr42'
    })
    expect(text).toContain('build')
    expect(text).toContain('https://github.com/acme/widget/pull/42')
    expect(text).toContain('fetch_check_logs')
    expect(text).toContain('append_finding')
    expect(text).toMatch(/layer/i)
    expect(text).toContain('/wt/widget-c1-pr42')
  })

  it('says there is no checkout instead of naming a null path', () => {
    const text = buildCiTriagePrompt({
      checkName: 'build',
      prUrl: 'https://github.com/acme/widget/pull/42',
      worktreePath: null
    })
    expect(text).not.toContain('null')
    expect(text).toMatch(/no local checkout/i)
  })
})

describe('composeCiTriagePrompt', () => {
  it('composes for a review session on the bound PR', async () => {
    seedSession('review')
    addBinding(db, 'c1', {
      repoPath: null,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    const text = await composeCiTriagePrompt({ db, argusHome: home }, 'c1', 1, 'build')
    expect(text).toContain('build')
    expect(text).toContain('https://github.com/acme/widget/pull/42')
  })

  it('refuses a session that belongs to another case', async () => {
    seedSession('review')
    createCase(db, home, { slug: 'c2', title: 'Case 2' })
    addBinding(db, 'c1', {
      repoPath: null,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    await expect(composeCiTriagePrompt({ db, argusHome: home }, 'c2', 1, 'build')).rejects.toThrow()
  })

  it('refuses when no PR is bound', async () => {
    seedSession('review')
    await expect(composeCiTriagePrompt({ db, argusHome: home }, 'c1', 1, 'build')).rejects.toThrow(
      /no pull request/i
    )
  })

  it('rejects an empty check name rather than composing a turn about nothing', async () => {
    seedSession('review')
    addBinding(db, 'c1', {
      repoPath: null,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    await expect(composeCiTriagePrompt({ db, argusHome: home }, 'c1', 1, '  ')).rejects.toThrow(
      /check name/i
    )
  })
})
