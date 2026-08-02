import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  CaseRecord,
  CaseResolution,
  CaseStatus,
  NewCaseInput,
  ReviewBaseline,
  SyncError
} from '../../shared/types'
import { derivePhase, type PhaseSignals } from '../../shared/casePhase'
import { CASE_PHASE_PINS, type CasePhase, type CasePhasePin } from '../../shared/types'
import { deriveActionItems, triageRank } from '../../shared/triage'
import { ARTIFACTS_PREFIX } from '../../shared/evidenceScope'
import { DEFAULT_MODE, MODES, type ModeId } from '../../shared/modes'
import { caseDir } from './paths'
import { appendDeletionAudit } from './deletionAudit'
import { deleteEvidenceFtsForCase, deleteMessagesFtsForCase } from './ftsIndex'
import { CAPTURE_DIR_REL } from './prompts/capture'
import { createSession, latestSessionForMode, type SessionProvider } from './agent/sessionStore'
import { materializePrBindings, type PrMaterializer } from './prBindings'

/** Case-slug shape; also reused by caseFiles path guards so a slug can never traverse. */
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Model-facing working rules written into every new case's CLAUDE.md.
 *  Registered as `generated-files.case-working-rules`. */
export const CASE_WORKING_RULES = `## Working rules

- Cite evidence as \`[<rel-path>:<line>]\` for every claim based on evidence, e.g. \`[evidence/app.log:812]\`.
- Record findings with the \`mcp__argus__append_finding\` tool — never edit \`findings.md\` directly.
- Search evidence with \`mcp__argus__search_evidence\` before grepping files.
- To inspect a linked repo at a branch/PR/tag, call \`mcp__argus__workspace_checkout\` — never \`git switch\`/\`checkout\` in the primary checkout.
- Register derived files you create as evidence via \`mcp__argus__ingest_artifact\` so they become searchable and citable.
`

function claudeMdTemplate(
  input: NewCaseInput,
  now: string,
  resolve?: (id: string) => string
): string {
  const rules = resolve ? resolve('generated-files.case-working-rules') : CASE_WORKING_RULES
  return `# Case: ${input.slug}

- Title: ${input.title}
- Jira: ${input.jiraKey ?? '(none)'}
- Opened: ${now}
- This directory is the case dir. Evidence lives in \`evidence/\`.

## Linked code workspaces

<!-- argus:workspaces -->
_No code workspaces linked._
<!-- /argus:workspaces -->

${rules}`
}

interface CaseRow {
  id: number
  slug: string
  title: string
  jira_key: string | null
  jira_synced_at: string | null
  jira_deselected: string | null
  jira_status: string | null
  jira_priority: string | null
  jira_comment_count: number | null
  jira_attachment_ids: string | null
  review_baseline: string | null
  last_sync_error: string | null
  status: string
  resolution: string | null
  phase_pin: string | null
  phase_pinned_at: string | null
  active_mode: string
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
    jiraDeselected: JSON.parse(r.jira_deselected ?? '[]') as string[],
    jiraStatus: r.jira_status ?? null,
    jiraPriority: r.jira_priority ?? null,
    jiraCommentCount: r.jira_comment_count ?? null,
    jiraAttachmentIds: JSON.parse(r.jira_attachment_ids ?? '[]') as string[],
    reviewBaseline: r.review_baseline ? (JSON.parse(r.review_baseline) as ReviewBaseline) : null,
    lastSyncError: r.last_sync_error ? (JSON.parse(r.last_sync_error) as SyncError) : null,
    status: r.status as CaseStatus,
    resolution: (r.resolution ?? null) as CaseResolution | null,
    // Lifecycle-only fallback so the field is never absent. listCases/getCase overwrite it
    // with the derived value (see attachPhase); a bare rowToCase caller gets the honest
    // minimum rather than a guess.
    phase: (r.status === 'closed' ? 'closed' : 'open') as CasePhase,
    // Defence in depth against a direct DB edit or a downgrade from a version that wrote
    // a mode this build no longer knows — same convention as sessionStore.ts's
    // sessionMode, which this mirrors exactly (see its comment for the failure mode this
    // guards against: MODES[mode] undefined, throwing on every later render).
    activeMode: r.active_mode in MODES ? (r.active_mode as ModeId) : DEFAULT_MODE,
    tags: JSON.parse(r.tags) as string[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    actionItems: []
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

export function createCase(
  db: DatabaseSync,
  argusHome: string,
  input: NewCaseInput,
  resolvePrompt?: (id: string) => string
): CaseRecord {
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
    for (const sub of ['evidence/.meta', 'artifacts/.meta', 'sessions', '.rca']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true })
    }
    const rec: CaseRecord = {
      id,
      slug: input.slug,
      title: input.title,
      jiraKey: input.jiraKey ?? null,
      jiraSyncedAt: null,
      jiraDeselected: [],
      jiraStatus: null,
      jiraPriority: null,
      jiraCommentCount: null,
      jiraAttachmentIds: [],
      reviewBaseline: null,
      lastSyncError: null,
      status: 'open',
      resolution: null,
      phase: 'open',
      activeMode: DEFAULT_MODE,
      tags: [],
      createdAt: now,
      updatedAt: now,
      actionItems: []
    }
    fs.writeFileSync(
      path.join(dir, 'case.json'),
      // phase/actionItems are DERIVED (shared/casePhase.ts, shared/triage.ts) — never
      // stored. Drop them the same way `id` already is: JSON.stringify omits an
      // undefined-valued key (Finding 7).
      JSON.stringify({ ...rec, id: undefined, phase: undefined, actionItems: undefined }, null, 2)
    )
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMdTemplate(input, now, resolvePrompt))
    scaffoldCaseLinks(argusHome, dir)
    fs.writeFileSync(path.join(dir, 'findings.md'), `# Findings — ${input.slug}\n`)
    return rec
  } catch (err) {
    db.prepare('DELETE FROM cases WHERE id = ?').run(id)
    throw err
  }
}

const IDLE_AFTER_MS = 14 * 86_400_000

/** Jira priority names, most urgent first. Unknown/unset sorts last. */
const PRIORITY_RANK: Record<string, number> = {
  highest: 0,
  high: 1,
  medium: 2,
  low: 3,
  lowest: 4
}
const PRIORITY_ORDER = (p: string | null): number => (p ? (PRIORITY_RANK[p.toLowerCase()] ?? 5) : 6)

/** Per-case timestamps that decide the phase. Everything is a MAX over an indexed case_id. */
interface CaseSignals {
  evidenceCount: number
  lastEvidenceAt: string | null
  lastInvestigationAt: string | null
  lastInvestigationFindingAt: string | null
  lastReviewAt: string | null
  lastReviewFindingAt: string | null
  /** Review-scoped evidence (artifacts/…) — see the evidence-scope split in readCaseSignals. */
  lastReviewEvidenceAt: string | null
  prLinkedAt: string | null
}

function emptySignals(): CaseSignals {
  return {
    evidenceCount: 0,
    lastEvidenceAt: null,
    lastInvestigationAt: null,
    lastInvestigationFindingAt: null,
    lastReviewAt: null,
    lastReviewFindingAt: null,
    lastReviewEvidenceAt: null,
    prLinkedAt: null
  }
}

/** `rel_path` pattern for review-scoped evidence — mirrors shared/evidenceScope.ts's
 *  scopeOfRelPath (artifacts/… is review, everything else is investigation). A SQL `CASE`
 *  can't call that function directly, so this LIKE pattern is the SQL-side copy; keep it in
 *  sync with ARTIFACTS_PREFIX if that ever changes. */
const ARTIFACTS_LIKE = `${ARTIFACTS_PREFIX}%`

/**
 * Four grouped reads covering every phase signal, plus the evidence count the `idle` triage
 * item needs (folded into the same query rather than adding a fifth).
 *
 * `caseId` scopes it to one case for getCase; omitted, it covers the whole table for
 * listCases. A turn's or finding's mode comes from `sessions.mode`, which is stamped at
 * session creation and never changes; sessions predating that column COALESCE to
 * `investigation`, matching how findings.ts already derives finding mode.
 */
function readCaseSignals(db: DatabaseSync, caseId?: number): Map<number, CaseSignals> {
  const out = new Map<number, CaseSignals>()
  const at = (id: number): CaseSignals => {
    let s = out.get(id)
    if (!s) {
      s = emptySignals()
      out.set(id, s)
    }
    return s
  }
  const scope = (col: string): string => (caseId === undefined ? '' : ` WHERE ${col} = ?`)
  const args: number[] = caseId === undefined ? [] : [caseId]

  // Evidence count is unscoped and unfiltered — every row, any origin, any scope — because
  // the `idle` triage heuristic below reads it as "has anything at all landed on this case",
  // not as a work signal. Do not fold origin/scope filtering into this query.
  for (const r of db
    .prepare(
      `SELECT case_id AS caseId, COUNT(*) AS n
         FROM evidence${scope('case_id')} GROUP BY case_id`
    )
    .all(...args) as unknown as Array<{ caseId: number; n: number }>) {
    at(r.caseId).evidenceCount = r.n
  }

  // The phase SIGNAL, unlike the count above, is scoped by directory and excludes
  // Jira-origin rows:
  //   - directory scope: review evidence (artifacts/…, see ARTIFACTS_LIKE — mirrors
  //     shared/evidenceScope.ts's scopeOfRelPath) feeds a new lastReviewEvidenceAt signal
  //     -> `reviewing` instead of falling into lastEvidenceAt -> `analyzing`. A CI log
  //     fetched mid-review (ciLogs.ts's fetch_check_logs) is the motivating case (Finding I1).
  //   - origin exclusion: Jira sync (createFromTicket/refresh in jiraCases.ts) ingests
  //     evidence with origin 'jira' as a side effect of syncing, not of the user's work, and
  //     the design's rule is that background sync must never move the phase (Finding I2) —
  //     otherwise a case created from a ticket is born "Analyzing" before a human touches it.
  const evidenceScopeCol = `CASE WHEN e.rel_path LIKE ? THEN 'review' ELSE 'investigation' END`
  for (const r of db
    .prepare(
      `SELECT e.case_id AS caseId, ${evidenceScopeCol} AS evScope, MAX(e.created_at) AS lastAt
         FROM evidence e
        WHERE e.origin != 'jira'${caseId === undefined ? '' : ' AND e.case_id = ?'}
        GROUP BY e.case_id, evScope`
    )
    .all(ARTIFACTS_LIKE, ...args) as unknown as Array<{
    caseId: number
    evScope: 'review' | 'investigation'
    lastAt: string | null
  }>) {
    const s = at(r.caseId)
    if (r.evScope === 'review') {
      if (!s.lastReviewEvidenceAt || (r.lastAt && r.lastAt > s.lastReviewEvidenceAt)) {
        s.lastReviewEvidenceAt = r.lastAt
      }
    } else if (!s.lastEvidenceAt || (r.lastAt && r.lastAt > s.lastEvidenceAt)) {
      s.lastEvidenceAt = r.lastAt
    }
  }

  for (const r of db
    .prepare(
      `SELECT t.case_id AS caseId, COALESCE(s.mode, 'investigation') AS mode,
              MAX(t.created_at) AS lastAt
         FROM turns t LEFT JOIN sessions s ON s.id = t.session_id${scope('t.case_id')}
        GROUP BY t.case_id, COALESCE(s.mode, 'investigation')`
    )
    .all(...args) as unknown as Array<{ caseId: number; mode: string; lastAt: string | null }>) {
    const s = at(r.caseId)
    // Max-preserving, not assigning: modes.ts anticipates a third mode, at which point two
    // non-review rows would arrive per case and a bare assignment would let whichever the
    // engine emits last silently clobber the other (Finding 4).
    if (r.mode === 'review') {
      if (!s.lastReviewAt || (r.lastAt && r.lastAt > s.lastReviewAt)) s.lastReviewAt = r.lastAt
    } else if (!s.lastInvestigationAt || (r.lastAt && r.lastAt > s.lastInvestigationAt)) {
      s.lastInvestigationAt = r.lastAt
    }
  }

  for (const r of db
    .prepare(
      `SELECT f.case_id AS caseId, COALESCE(s.mode, 'investigation') AS mode,
              MAX(f.created_at) AS lastAt
         FROM findings f LEFT JOIN sessions s ON s.id = f.session_id${scope('f.case_id')}
        GROUP BY f.case_id, COALESCE(s.mode, 'investigation')`
    )
    .all(...args) as unknown as Array<{ caseId: number; mode: string; lastAt: string | null }>) {
    const s = at(r.caseId)
    if (r.mode === 'review') {
      if (!s.lastReviewFindingAt || (r.lastAt && r.lastAt > s.lastReviewFindingAt)) {
        s.lastReviewFindingAt = r.lastAt
      }
    } else if (
      !s.lastInvestigationFindingAt ||
      (r.lastAt && r.lastAt > s.lastInvestigationFindingAt)
    ) {
      s.lastInvestigationFindingAt = r.lastAt
    }
  }

  for (const r of db
    .prepare(
      `SELECT case_id AS caseId, detected_at AS linkedAt FROM pr_bindings${scope('case_id')}`
    )
    .all(...args) as unknown as Array<{ caseId: number; linkedAt: string }>) {
    at(r.caseId).prLinkedAt = r.linkedAt
  }

  return out
}

/** Marry a record to its signals and its stored pin. */
function attachPhase(c: CaseRecord, row: CaseRow, sig: CaseSignals): CasePhase {
  const signals: PhaseSignals = {
    status: c.status,
    lastEvidenceAt: sig.lastEvidenceAt,
    lastInvestigationAt: sig.lastInvestigationAt,
    lastInvestigationFindingAt: sig.lastInvestigationFindingAt,
    prLinkedAt: sig.prLinkedAt,
    lastReviewAt: sig.lastReviewAt,
    lastReviewFindingAt: sig.lastReviewFindingAt,
    lastReviewEvidenceAt: sig.lastReviewEvidenceAt,
    // Defence in depth against a direct DB edit or a downgrade from a future build that
    // wrote a pin this build does not know — same convention as rowToCase's activeMode
    // guard against MODES.
    phasePin: CASE_PHASE_PINS.includes(row.phase_pin as CasePhasePin)
      ? (row.phase_pin as CasePhasePin)
      : null,
    phasePinnedAt: row.phase_pinned_at ?? null
  }
  return derivePhase(signals)
}

/**
 * Triage order: action items first, then info-only, then untouched cases;
 * ties break on updatedAt desc. Replaces the old created_at ordering, which
 * disagreed with the updatedAt the cards actually displayed.
 */
export function listCases(db: DatabaseSync): CaseRecord[] {
  const rows = db.prepare(`SELECT * FROM cases`).all() as unknown as CaseRow[]
  const signals = readCaseSignals(db)

  const now = new Date()
  const cases = rows.map((row) => {
    const c = rowToCase(row)
    const sig = signals.get(c.id) ?? emptySignals()
    const items = deriveActionItems(c, now)
    const idle =
      c.status === 'open' &&
      sig.evidenceCount === 0 &&
      now.getTime() - new Date(c.createdAt).getTime() > IDLE_AFTER_MS
    if (idle) {
      const weeks = Math.floor((now.getTime() - new Date(c.createdAt).getTime()) / (7 * 86_400_000))
      items.push({ kind: 'idle', severity: 'info', label: `open ${weeks}w, no evidence` })
    }
    return { ...c, actionItems: items, phase: attachPhase(c, row, sig) }
  })

  return cases.sort((a, b) => {
    const d = triageRank(a.actionItems) - triageRank(b.actionItems)
    if (d !== 0) return d
    const u = b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0
    if (u !== 0) return u
    const p = PRIORITY_ORDER(a.jiraPriority) - PRIORITY_ORDER(b.jiraPriority)
    if (p !== 0) return p
    // Priority was the last key, which left fully-tied cases on `sort`'s stability — i.e.
    // on the order `SELECT * FROM cases` happened to return, which is rowid order, which
    // is oldest-first: the reverse of what every other key here means. `createdAt`/
    // `updatedAt` are ISO strings with millisecond resolution, so two cases created inside
    // one millisecond tie on `u` above, and on macOS CI that happened often enough to fail
    // `lists newest first` in 3 of 50 full-suite runs. Newest id first restores the
    // intended sense and makes the order total, so the dashboard cannot reshuffle two
    // same-millisecond cases between reads either.
    return b.id - a.id
  })
}

export function getCase(db: DatabaseSync, slug: string): CaseRecord | null {
  const row = db.prepare(`SELECT * FROM cases WHERE slug = ?`).get(slug) as unknown as
    CaseRow | undefined
  if (!row) return null
  const c = rowToCase(row)
  // Derived here too, so `phase` is never a lie on a single-case read. `actionItems` stays
  // empty — that is pre-existing behaviour and out of scope.
  const sig = readCaseSignals(db, c.id).get(c.id) ?? emptySignals()
  return { ...c, phase: attachPhase(c, row, sig) }
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
    onDisk = { ...existing, id: undefined, phase: undefined, actionItems: undefined }
  }
  const jiraWithDeselected =
    existing.jiraDeselected.length > 0
      ? { ...jira, deselectedAttachmentIds: existing.jiraDeselected }
      : jira
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        ...onDisk,
        jiraKey: jira.key,
        updatedAt: now,
        jira: jiraWithDeselected
      },
      null,
      2
    )
  )
  return getCase(db, slug)!
}

/** Persist which Jira attachments the user declined; mirrored into case.json's jira block. */
export function setCaseJiraDeselected(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  deselected: string[]
): CaseRecord {
  const existing = getCase(db, slug)
  if (!existing) throw new Error(`Unknown case: ${slug}`)
  const now = new Date().toISOString()
  db.prepare(`UPDATE cases SET jira_deselected = ?, updated_at = ? WHERE slug = ?`).run(
    JSON.stringify(deselected),
    now,
    slug
  )
  const file = path.join(caseDir(argusHome, slug), 'case.json')
  let onDisk: Record<string, unknown>
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    onDisk = { ...existing, id: undefined, phase: undefined, actionItems: undefined }
  }
  const jira = { ...((onDisk.jira as object) ?? {}), deselectedAttachmentIds: deselected }
  fs.writeFileSync(file, JSON.stringify({ ...onDisk, updatedAt: now, jira }, null, 2))
  return getCase(db, slug)!
}

export interface CaseSyncState {
  jiraStatus?: string | null
  jiraPriority?: string | null
  jiraCommentCount?: number | null
  jiraAttachmentIds?: string[]
  lastSyncError?: SyncError | null
}

/**
 * Persist the upstream snapshot a sync produced. Every field is optional: a
 * failed sync writes only lastSyncError and leaves the last-known-good values
 * intact, so the card shows stale data plainly marked rather than blank.
 *
 * Does NOT touch updated_at — a sync that changed nothing must not reorder the
 * dashboard, which breaks ties on updatedAt.
 */
export function setCaseSyncState(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  state: CaseSyncState
): CaseRecord {
  const existing = getCase(db, slug)
  if (!existing) throw new Error(`Unknown case: ${slug}`)

  const sets: string[] = []
  const vals: Array<string | number | null> = []
  if ('jiraStatus' in state) {
    sets.push('jira_status = ?')
    vals.push(state.jiraStatus ?? null)
  }
  if ('jiraPriority' in state) {
    sets.push('jira_priority = ?')
    vals.push(state.jiraPriority ?? null)
  }
  if ('jiraCommentCount' in state) {
    sets.push('jira_comment_count = ?')
    vals.push(state.jiraCommentCount ?? null)
  }
  if ('jiraAttachmentIds' in state) {
    sets.push('jira_attachment_ids = ?')
    vals.push(JSON.stringify(state.jiraAttachmentIds ?? []))
  }
  if ('lastSyncError' in state) {
    sets.push('last_sync_error = ?')
    vals.push(state.lastSyncError ? JSON.stringify(state.lastSyncError) : null)
  }
  if (sets.length === 0) return existing

  db.prepare(`UPDATE cases SET ${sets.join(', ')} WHERE slug = ?`).run(...vals, slug)
  const updated = getCase(db, slug)!

  // Mirror into case.json like every other case writer, so an exported/imported
  // bundle carries sync state and the dir stays the readable source of truth.
  const file = path.join(caseDir(argusHome, slug), 'case.json')
  let onDisk: Record<string, unknown>
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    // phase/actionItems are DERIVED — never stored (Finding 7, same as createCase's fix).
    onDisk = { ...updated, id: undefined, phase: undefined, actionItems: undefined }
  }
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        ...onDisk,
        jiraStatus: updated.jiraStatus,
        jiraPriority: updated.jiraPriority,
        jiraCommentCount: updated.jiraCommentCount,
        jiraAttachmentIds: updated.jiraAttachmentIds,
        lastSyncError: updated.lastSyncError
      },
      null,
      2
    )
  )
  return updated
}

/** Capture (or clear) the snapshot that sync diffs against; mirrored into case.json. */
export function setReviewBaseline(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  baseline: ReviewBaseline | null
): CaseRecord {
  const existing = getCase(db, slug)
  if (!existing) throw new Error(`Unknown case: ${slug}`)
  db.prepare(`UPDATE cases SET review_baseline = ? WHERE slug = ?`).run(
    baseline ? JSON.stringify(baseline) : null,
    slug
  )

  const file = path.join(caseDir(argusHome, slug), 'case.json')
  let onDisk: Record<string, unknown>
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    // phase/actionItems are DERIVED — never stored (Finding 7, same as createCase's fix).
    onDisk = { ...existing, id: undefined, phase: undefined, actionItems: undefined }
  }
  fs.writeFileSync(file, JSON.stringify({ ...onDisk, reviewBaseline: baseline }, null, 2))
  return getCase(db, slug)!
}

/**
 * The single writer for a case's lifecycle status + resolution. Only `open` and
 * `closed` are valid — everything else is a derived `CasePhase` (see
 * shared/casePhase.ts) and must go through `pinCasePhase` instead if it cannot be
 * derived. Enforces the invariant (resolution non-null iff status === 'closed'),
 * updates the DB row, and mirrors status/resolution into case.json. Used by the
 * human IPC path and the agent update_case_status tool.
 */
export function setCaseStatus(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  status: CaseStatus,
  resolution: CaseResolution | null,
  onClosed?: (rec: CaseRecord) => void
): CaseRecord {
  const existing = getCase(db, slug)
  if (!existing) throw new Error(`Unknown case: ${slug}`)
  if (status !== 'open' && status !== 'closed') {
    throw new Error(
      `Unknown case status: ${JSON.stringify(status)} — the lifecycle is open|closed; ` +
        `everything else is a derived phase (see shared/casePhase.ts)`
    )
  }
  if (status === 'closed' && resolution === null) {
    throw new Error('Closing a case requires a resolution reason')
  }
  const nextResolution = status === 'closed' ? resolution : null
  const now = new Date().toISOString()
  db.prepare(`UPDATE cases SET status = ?, resolution = ?, updated_at = ? WHERE slug = ?`).run(
    status,
    nextResolution,
    now,
    slug
  )

  const file = path.join(caseDir(argusHome, slug), 'case.json')
  let onDisk: Record<string, unknown>
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    // corrupt/unreadable case.json — rebuild from the DB record (same shape as
    // createCase: full record minus id) so other fields survive. phase/actionItems are
    // DERIVED — never stored (Finding 7, same as createCase's fix).
    onDisk = { ...existing, id: undefined, phase: undefined, actionItems: undefined }
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ ...onDisk, status, resolution: nextResolution, updatedAt: now }, null, 2)
  )
  const closingNow = existing.status !== 'closed' && status === 'closed'
  const updated = getCase(db, slug)!
  if (closingNow && onClosed) {
    try {
      onClosed(updated)
    } catch (err) {
      console.error('[caseService] onClosed hook failed', err)
    }
  }
  return updated
}

/**
 * Declare a phase that cannot be derived from any artifact — today only `rca-drafted`, which
 * no file, table or rule produces. Mirrors setCaseStatus's shape: validate, update the row,
 * mirror into case.json.
 *
 * A pin is NOT sticky. It competes on `phase_pinned_at` against every other signal, so the
 * next thing that happens on the case supersedes it (see shared/casePhase.ts). It is never
 * cleared, only outranked — which is what lets reopening a closed case restore the phase it
 * showed before.
 */
export function pinCasePhase(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  pin: CasePhasePin
): CaseRecord {
  if (!CASE_PHASE_PINS.includes(pin)) {
    throw new Error(
      `Unknown phase pin: ${JSON.stringify(pin)} — expected ${CASE_PHASE_PINS.join('|')}`
    )
  }
  const existing = getCase(db, slug)
  if (!existing) throw new Error(`Unknown case: ${slug}`)
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE cases SET phase_pin = ?, phase_pinned_at = ?, updated_at = ? WHERE slug = ?`
  ).run(pin, now, now, slug)

  const file = path.join(caseDir(argusHome, slug), 'case.json')
  let onDisk: Record<string, unknown>
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    // corrupt/unreadable case.json — rebuild from the DB record, same as setCaseStatus.
    // phase/actionItems are DERIVED — never stored (Finding 7).
    onDisk = { ...existing, id: undefined, phase: undefined, actionItems: undefined }
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ ...onDisk, phasePin: pin, phasePinnedAt: now, updatedAt: now }, null, 2)
  )
  return getCase(db, slug)!
}

/**
 * The single writer for which mode (see shared/modes.ts) a case is currently switched
 * to. Mirrors setCaseStatus's pattern: validate, update the DB row, mirror into
 * case.json, return the fresh record's session to switch to.
 *
 * A session's mode is pinned at creation and immutable thereafter (setSessionMode no
 * longer exists), so switching a case's mode never mutates any existing chat — it only
 * decides which chat is active: the mode's most recent session, or a freshly created one
 * bound to it when none exists yet. This is what lets the other mode's chats sit
 * untouched until the user switches back to them.
 *
 * `provider` is what a freshly created chat should run on — the caller passes the same
 * thing the sessions:create IPC handler does (main/index.ts's `newSessionProvider()`),
 * so a mode-switch-created chat is pinned exactly like one a user creates by hand. This
 * used to be re-resolved in here via a one-off SettingsService (a second file watcher
 * per mode switch) through a driver catalog that didn't actually agree with
 * `getActiveDriver`'s fallback; taking it as a parameter removes both problems.
 *
 * Entering `review` also checks out every bound PR that has a local clone, via the
 * injected `materialize` (main/index.ts supplies the `ensurePrWorktree`-backed one; tests
 * a fake). It runs for already-bound PRs whose worktree may be absent — a fresh clone,
 * another machine, a pruned worktree — and shares `materializePrBindings` with the PR
 * picker's confirm path so the two cannot drift. Failures are logged, never fatal.
 */
export async function setCaseMode(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  mode: ModeId,
  provider: SessionProvider,
  opts?: { materialize?: PrMaterializer }
): Promise<{ sessionId: number }> {
  if (!(mode in MODES)) throw new Error(`Unknown mode: ${mode}`)
  const existing = getCase(db, slug)
  if (!existing) throw new Error(`Unknown case: ${slug}`)
  const now = new Date().toISOString()
  db.prepare(`UPDATE cases SET active_mode = ?, updated_at = ? WHERE slug = ?`).run(mode, now, slug)

  const file = path.join(caseDir(argusHome, slug), 'case.json')
  let onDisk: Record<string, unknown>
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    // corrupt/unreadable case.json — rebuild from the DB record (same shape as
    // createCase: full record minus id) so other fields survive.
    onDisk = { ...existing, id: undefined, phase: undefined, actionItems: undefined }
  }
  fs.writeFileSync(file, JSON.stringify({ ...onDisk, activeMode: mode, updatedAt: now }, null, 2))

  if (mode === 'review' && opts?.materialize) {
    await materializePrBindings(db, argusHome, slug, opts.materialize)
  }

  const target = latestSessionForMode(db, slug, mode)
  if (target) return { sessionId: target.id }
  const created = createSession(db, slug, { ...provider, mode })
  return { sessionId: created.id }
}

/**
 * Hard-delete a case. Order: FTS rows (evidence_fts/messages_fts have no FK — the
 * evidence map lookup joins evidence rows, so clean it BEFORE the cascade destroys
 * those rows) → cases row (FK cascade takes evidence/sessions/turns/tool_calls/
 * findings; their case_id columns are now indexed) → distill
 * tables (case_summaries, case_summaries_fts, distill_jobs — keyed by
 * case_slug, not case_id, so the cascade above doesn't touch them) → audit →
 * case directory → dev-tools prompt capture directory (best-effort; a captured
 * systemAppend includes the persona, pack fragments and the agent-access-filtered
 * memory index, so a deleted case's prompt text must not survive it). Callers must
 * first stop live sessions (AgentService.stopAllForCase) and close the case's file
 * watcher. rmSync removes the .claude junctions as links, never their targets.
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
    // FTS rows resolve through the map by rowid (ftsIndex.ts) — must run BEFORE the
    // cascade below deletes the evidence rows the evidence map lookup joins against.
    deleteEvidenceFtsForCase(db, rec.id)
    deleteMessagesFtsForCase(db, rec.id)
    db.prepare(`DELETE FROM cases WHERE id = ?`).run(rec.id)
    db.prepare(`DELETE FROM case_summaries WHERE case_slug = ?`).run(slug)
    db.prepare(`DELETE FROM case_summaries_fts WHERE case_slug = ?`).run(slug)
    db.prepare(`DELETE FROM distill_jobs WHERE case_slug = ?`).run(slug)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  appendDeletionAudit(argusHome, 'case.delete', slug, detail)
  fs.rmSync(caseDir(argusHome, slug), { recursive: true, force: true })
  // Best-effort: case deletion is the more important operation, so a failure to remove the
  // capture directory (locked file, permissions) must not surface as a failed case deletion.
  try {
    fs.rmSync(path.join(argusHome, CAPTURE_DIR_REL, slug), { recursive: true, force: true })
  } catch (err) {
    console.warn(`[prompts] failed to remove capture directory for deleted case ${slug}:`, err)
  }
}
