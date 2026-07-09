import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CaseRecord, CaseStatus, NewCaseInput } from '../../shared/types'
import { caseDir } from './paths'

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

interface CaseRow {
  id: number
  slug: string
  title: string
  jira_key: string | null
  status: string
  tags: string
  created_at: string
  updated_at: string
}

function rowToCase(r: CaseRow): CaseRecord {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    jiraKey: r.jira_key,
    status: r.status as CaseStatus,
    tags: JSON.parse(r.tags) as string[],
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function createCase(db: DatabaseSync, argusHome: string, input: NewCaseInput): CaseRecord {
  if (!SLUG_RE.test(input.slug)) {
    throw new Error(`Invalid case slug: ${JSON.stringify(input.slug)}`)
  }
  const now = new Date().toISOString()
  const res = db
    .prepare(
      `INSERT INTO cases (slug, title, jira_key, status, tags, created_at, updated_at)
       VALUES (?, ?, ?, 'open', '[]', ?, ?)`
    )
    .run(input.slug, input.title, input.jiraKey ?? null, now, now)

  const dir = caseDir(argusHome, input.slug)
  for (const sub of ['evidence/.meta', 'sessions', '.rca']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true })
  }
  const rec: CaseRecord = {
    id: Number(res.lastInsertRowid),
    slug: input.slug,
    title: input.title,
    jiraKey: input.jiraKey ?? null,
    status: 'open',
    tags: [],
    createdAt: now,
    updatedAt: now
  }
  fs.writeFileSync(
    path.join(dir, 'case.json'),
    JSON.stringify({ ...rec, id: undefined }, null, 2)
  )
  fs.writeFileSync(
    path.join(dir, 'CLAUDE.md'),
    `# Case: ${input.slug}\n\n## Context\n\n- Title: ${input.title}\n- Jira: ${input.jiraKey ?? '(none)'}\n- Opened: ${now}\n\n## Scope\n\n(fill in during triage)\n`
  )
  fs.writeFileSync(path.join(dir, 'findings.md'), `# Findings — ${input.slug}\n`)
  return rec
}

export function listCases(db: DatabaseSync): CaseRecord[] {
  const rows = db.prepare(`SELECT * FROM cases ORDER BY created_at DESC, id DESC`).all() as unknown as CaseRow[]
  return rows.map(rowToCase)
}

export function getCase(db: DatabaseSync, slug: string): CaseRecord | null {
  const row = db.prepare(`SELECT * FROM cases WHERE slug = ?`).get(slug) as unknown as CaseRow | undefined
  return row ? rowToCase(row) : null
}
