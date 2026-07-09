import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase, listCases, getCase } from '../caseService'
import type { DatabaseSync } from 'node:sqlite'

let home: string
let db: DatabaseSync

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
})

describe('createCase', () => {
  it('inserts a row and scaffolds the case dir', () => {
    const rec = createCase(db, home, {
      slug: 'NAVAPI-12345',
      title: 'Tile 403s',
      jiraKey: 'NAVAPI-12345'
    })
    expect(rec.slug).toBe('NAVAPI-12345')
    expect(rec.status).toBe('open')
    const dir = path.join(home, 'cases', 'NAVAPI-12345')
    for (const p of [
      'evidence',
      'evidence/.meta',
      'sessions',
      '.rca',
      'case.json',
      'CLAUDE.md',
      'findings.md'
    ]) {
      expect(fs.existsSync(path.join(dir, p)), p).toBe(true)
    }
    const caseJson = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'))
    expect(caseJson.slug).toBe('NAVAPI-12345')
    expect(caseJson.status).toBe('open')
  })

  it('rejects invalid slugs', () => {
    expect(() => createCase(db, home, { slug: '../evil', title: 'x' })).toThrow(/slug/i)
    expect(() => createCase(db, home, { slug: 'has space', title: 'x' })).toThrow(/slug/i)
  })

  it('rejects duplicate slugs', () => {
    createCase(db, home, { slug: 'CASE-1', title: 'a' })
    expect(() => createCase(db, home, { slug: 'CASE-1', title: 'b' })).toThrow()
  })

  it('scaffolds .claude symlinks and the working-rules CLAUDE.md', () => {
    // ensure shared dirs exist first
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(home, 'references'), { recursive: true })
    createCase(db, home, { slug: 'SCAF-1', title: 'scaffold' })
    const dir = path.join(home, 'cases', 'SCAF-1')
    expect(fs.lstatSync(path.join(dir, '.claude', 'skills')).isSymbolicLink()).toBe(true)
    const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain('mcp__argus__append_finding')
    expect(claudeMd).toContain('<!-- argus:workspaces -->')
  })

  it('rolls back the DB row when scaffolding fails', () => {
    // a FILE at cases/ makes mkdirSync throw ENOTDIR/EEXIST for any case dir
    fs.writeFileSync(path.join(home, 'cases'), 'not a directory')
    expect(() => createCase(db, home, { slug: 'ROLLBACK-1', title: 'x' })).toThrow()
    expect(getCase(db, 'ROLLBACK-1')).toBeNull()
  })
})

describe('listCases / getCase', () => {
  it('lists newest first and fetches by slug', () => {
    createCase(db, home, { slug: 'A-1', title: 'first' })
    createCase(db, home, { slug: 'B-2', title: 'second' })
    const all = listCases(db)
    expect(all.map((c) => c.slug)).toEqual(['B-2', 'A-1'])
    expect(getCase(db, 'A-1')?.title).toBe('first')
    expect(getCase(db, 'missing')).toBeNull()
  })
})
