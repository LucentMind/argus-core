import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CaseRecord, CaseStatus, NewCaseInput } from '../../shared/types'
import { caseDir } from './paths'

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function claudeMdTemplate(input: NewCaseInput, now: string): string {
  return `# Case: ${input.slug}

- Title: ${input.title}
- Jira: ${input.jiraKey ?? '(none)'}
- Opened: ${now}
- This directory is the case dir. Evidence lives in \`evidence/\`.

## Linked code workspaces

<!-- argus:workspaces -->
_No code workspaces linked._
<!-- /argus:workspaces -->

## Working rules

- Cite evidence as \`[<rel-path>:<line>]\` for every claim based on evidence, e.g. \`[evidence/applog.txt:812]\`.
- Record findings with the \`mcp__argus__append_finding\` tool — never edit \`findings.md\` directly.
- Search evidence with \`mcp__argus__search_evidence\` before grepping files.
- Trace files (applog, BINLOG, recordings, bintrace): use the \`sample-trace\` / \`sample-parse\` CLIs — never raw grep/cat; they have guardrails and output caps.
- To inspect a linked repo at a branch/PR/tag, call \`mcp__argus__workspace_checkout\` — never \`git switch\`/\`checkout\` in the primary checkout.
- Register derived files you create as evidence via \`mcp__argus__ingest_artifact\` so they become searchable and citable.
`
}

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

  const id = Number(res.lastInsertRowid)
  const dir = caseDir(argusHome, input.slug)

  try {
    for (const sub of ['evidence/.meta', 'sessions', '.rca']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true })
    }
    const rec: CaseRecord = {
      id,
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
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMdTemplate(input, now))
    const dotClaude = path.join(dir, '.claude')
    fs.mkdirSync(dotClaude, { recursive: true })
    for (const [name, target] of [
      ['skills', path.join(argusHome, 'skills')],
      ['references', path.join(argusHome, 'references')]
    ] as const) {
      const link = path.join(dotClaude, name)
      // 'dir' symlinks need elevation on Windows; junctions don't and lstat still
      // reports them as symbolic links.
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      if (!fs.existsSync(link) && fs.existsSync(target)) fs.symlinkSync(target, link, linkType)
    }
    fs.writeFileSync(path.join(dir, 'findings.md'), `# Findings — ${input.slug}\n`)
    return rec
  } catch (err) {
    db.prepare('DELETE FROM cases WHERE id = ?').run(id)
    throw err
  }
}

export function listCases(db: DatabaseSync): CaseRecord[] {
  const rows = db
    .prepare(`SELECT * FROM cases ORDER BY created_at DESC, id DESC`)
    .all() as unknown as CaseRow[]
  return rows.map(rowToCase)
}

export function getCase(db: DatabaseSync, slug: string): CaseRecord | null {
  const row = db.prepare(`SELECT * FROM cases WHERE slug = ?`).get(slug) as unknown as
    CaseRow | undefined
  return row ? rowToCase(row) : null
}

export interface CaseJiraLink {
  key: string
  site: string
  lastSyncedAt: string
}

/** Link/refresh the Jira binding: DB jira_key + a `jira` block merged into case.json. */
export function setCaseJira(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  jira: CaseJiraLink
): CaseRecord {
  const existing = getCase(db, slug)
  if (!existing) throw new Error(`Unknown case: ${slug}`)
  const now = new Date().toISOString()
  db.prepare(`UPDATE cases SET jira_key = ?, updated_at = ? WHERE slug = ?`).run(
    jira.key,
    now,
    slug
  )

  const file = path.join(caseDir(argusHome, slug), 'case.json')
  let onDisk: Record<string, unknown>
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    // case.json is corrupt/unreadable — rebuild the rewrite base from the DB record
    // (same on-disk shape as createCase: the full record minus `id`) so title/status/
    // tags survive instead of being dropped by an empty-object fallback.
    onDisk = { ...existing, id: undefined }
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ ...onDisk, jiraKey: jira.key, updatedAt: now, jira }, null, 2)
  )
  return getCase(db, slug)!
}
