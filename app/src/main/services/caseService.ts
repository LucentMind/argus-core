import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CaseRecord, CaseResolution, CaseStatus, NewCaseInput } from '../../shared/types'
import { caseDir } from './paths'
import { appendDeletionAudit } from './deletionAudit'

/** Case-slug shape; also reused by caseFiles path guards so a slug can never traverse. */
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

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

- Cite evidence as \`[<rel-path>:<line>]\` for every claim based on evidence, e.g. \`[evidence/app.log:812]\`.
- Record findings with the \`mcp__argus__append_finding\` tool — never edit \`findings.md\` directly.
- Search evidence with \`mcp__argus__search_evidence\` before grepping files.
- To inspect a linked repo at a branch/PR/tag, call \`mcp__argus__workspace_checkout\` — never \`git switch\`/\`checkout\` in the primary checkout.
- Register derived files you create as evidence via \`mcp__argus__ingest_artifact\` so they become searchable and citable.
`
}

interface CaseRow {
  id: number
  slug: string
  title: string
  jira_key: string | null
  jira_synced_at: string | null
  status: string
  resolution: string | null
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
    jiraSyncedAt: r.jira_synced_at ?? null,
    status: r.status as CaseStatus,
    resolution: (r.resolution ?? null) as CaseResolution | null,
    tags: JSON.parse(r.tags) as string[],
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/**
 * (Re)create the machine-local `.claude` junctions (skills, references).
 * Idempotent; used by createCase and by bundle import (bundles never carry
 * the junction farm).
 */
export function scaffoldCaseLinks(argusHome: string, dir: string): void {
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
}

export function createCase(db: DatabaseSync, argusHome: string, input: NewCaseInput): CaseRecord {
  if (!SLUG_RE.test(input.slug)) {
    throw new Error(`Invalid case slug: ${JSON.stringify(input.slug)}`)
  }
  const now = new Date().toISOString()
  const res = db
    .prepare(
      `INSERT INTO cases (slug, title, jira_key, status, resolution, tags, created_at, updated_at)
       VALUES (?, ?, ?, 'open', NULL, '[]', ?, ?)`
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
      jiraSyncedAt: null,
      status: 'open',
      resolution: null,
      tags: [],
      createdAt: now,
      updatedAt: now
    }
    fs.writeFileSync(
      path.join(dir, 'case.json'),
      JSON.stringify({ ...rec, id: undefined }, null, 2)
    )
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMdTemplate(input, now))
    scaffoldCaseLinks(argusHome, dir)
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
  db.prepare(
    `UPDATE cases SET jira_key = ?, jira_synced_at = ?, updated_at = ? WHERE slug = ?`
  ).run(jira.key, jira.lastSyncedAt, now, slug)

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

/**
 * The single writer for a case's lifecycle status + resolution. Enforces the
 * invariant (resolution non-null iff status === 'closed'), updates the DB row,
 * and mirrors status/resolution into case.json. Used by the human IPC path, the
 * agent update_case_status tool, and the auto-analyze helper.
 */
export function setCaseStatus(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  status: CaseStatus,
  resolution: CaseResolution | null
): CaseRecord {
  const existing = getCase(db, slug)
  if (!existing) throw new Error(`Unknown case: ${slug}`)
  if (status === 'closed' && resolution === null) {
    throw new Error('Closing a case requires a resolution reason')
  }
  const nextResolution = status === 'closed' ? resolution : null
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE cases SET status = ?, resolution = ?, updated_at = ? WHERE slug = ?`
  ).run(status, nextResolution, now, slug)

  const file = path.join(caseDir(argusHome, slug), 'case.json')
  let onDisk: Record<string, unknown>
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    // corrupt/unreadable case.json — rebuild from the DB record (same shape as
    // createCase: full record minus id) so other fields survive.
    onDisk = { ...existing, id: undefined }
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ ...onDisk, status, resolution: nextResolution, updatedAt: now }, null, 2)
  )
  return getCase(db, slug)!
}

/**
 * Auto-advance a case from 'open' to 'analyzing' once it has both evidence and a
 * started chat (a turn row). No-op for any non-'open' status, so it never
 * downgrades analyzing/rca-drafted/closed. Called after an interactive evidence
 * ingest and after a chat turn is created.
 */
export function maybeAdvanceToAnalyzing(
  db: DatabaseSync,
  argusHome: string,
  caseId: number
): void {
  const row = db
    .prepare(`SELECT slug, status FROM cases WHERE id = ?`)
    .get(caseId) as { slug: string; status: string } | undefined
  if (!row || row.status !== 'open') return
  const hasEvidence =
    (db.prepare(`SELECT 1 FROM evidence WHERE case_id = ? LIMIT 1`).get(caseId) as unknown) != null
  const hasTurn =
    (db.prepare(`SELECT 1 FROM turns WHERE case_id = ? LIMIT 1`).get(caseId) as unknown) != null
  if (hasEvidence && hasTurn) {
    setCaseStatus(db, argusHome, row.slug, 'analyzing', null)
  }
}

/**
 * Hard-delete a case. Order: FTS rows (evidence_fts has no case_id — clean it
 * via the evidence subquery BEFORE the cascade destroys those rows) → cases
 * row (FK cascade takes evidence/sessions/turns/tool_calls/findings) → audit →
 * case directory. Callers must first stop live sessions
 * (AgentService.stopAllForCase) and close the case's file watcher. rmSync
 * removes the .claude junctions as links, never their targets.
 */
export function deleteCase(db: DatabaseSync, argusHome: string, slug: string): void {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid case slug: ${JSON.stringify(slug)}`)
  const rec = getCase(db, slug)
  if (!rec) throw new Error(`Unknown case: ${slug}`)
  const count = (table: string): number =>
    Number(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE case_id = ?`).get(rec.id) as {
          n: number
        }
      ).n
    )
  const detail = {
    title: rec.title,
    evidence: count('evidence'),
    sessions: count('sessions'),
    findings: count('findings')
  }
  db.exec('BEGIN')
  try {
    db.prepare(
      `DELETE FROM evidence_fts WHERE evidence_id IN (SELECT id FROM evidence WHERE case_id = ?)`
    ).run(rec.id)
    db.prepare(`DELETE FROM messages_fts WHERE case_id = ?`).run(rec.id)
    db.prepare(`DELETE FROM cases WHERE id = ?`).run(rec.id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  appendDeletionAudit(argusHome, 'case.delete', slug, detail)
  fs.rmSync(caseDir(argusHome, slug), { recursive: true, force: true })
}
