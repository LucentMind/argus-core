import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  CaseOrigin,
  CaseRecord,
  CaseResolution,
  CaseReviewState,
  CaseStatus,
  NewCaseInput,
  ReviewBaseline,
  SyncError
} from '../../shared/types'
import { derivePhase, type PhaseSignals } from '../../shared/casePhase'
import { CASE_PHASE_PINS, type CasePhase, type CasePhasePin } from '../../shared/types'
import { deriveActionItems, triageRank } from '../../shared/triage'
import { ARTIFACTS_LIKE } from './evidenceScopeSql'
import { DEFAULT_MODE, MODES, type ModeId } from '../../shared/modes'
import { caseDir, caseArchivePath } from './paths'
import { isCaseFrozen } from './caseFreeze'
import { appendDeletionAudit } from './deletionAudit'
import { deleteEvidenceFtsForCase, deleteMessagesFtsForCase } from './ftsIndex'
import { CAPTURE_DIR_REL } from './prompts/capture'
import { createSession, latestSessionForMode, type SessionProvider } from './agent/sessionStore'
import { materializePrBindings, type PrMaterializer } from './prBindings'
import type { TicketProviderId } from '../../shared/ticketRef'

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
  origin: string
  review_state: string | null
  title: string
  jira_key: string | null
  ticket_provider: string
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
  archived_at: string | null
  archive_path: string | null
  archive_sha256: string | null
  last_opened_at: string | null
}

function rowToCase(r: CaseRow): CaseRecord {
  return {
    id: r.id,
    slug: r.slug,
    // Defence in depth against a direct DB edit or a downgrade, same convention as activeMode
    // below: an unknown value reads as the default rather than reaching the renderer's chip
    // logic as a string it has never heard of.
    origin: (r.origin === 'routine' ? 'routine' : 'user') as CaseOrigin,
    reviewState: (r.review_state as CaseReviewState) ?? null,
    title: r.title,
    jiraKey: r.jira_key,
    // Defence in depth against a direct DB edit or a downgrade, same convention as `origin`
    // and `activeMode`: an unknown value reads as the default rather than reaching a provider
    // registry lookup that would throw on every render.
    ticketProvider: (r.ticket_provider === 'github' ? 'github' : 'jira') as TicketProviderId,
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
    actionItems: [],
    // Derived like `phase` above; listCases overwrites it from the turn signals. A bare
    // rowToCase caller gets the honest "unknown", not a guess at `updated_at`.
    lastWorkedAt: null,
    archivedAt: r.archived_at ?? null,
    archivePath: r.archive_path ?? null,
    lastOpenedAt: r.last_opened_at ?? null
  }
}

/**
 * Drop every DERIVED field before a record is written to `case.json`.
 *
 * `id`, `phase`, `actionItems` and `lastWorkedAt` are computed on read (shared/casePhase.ts,
 * shared/triage.ts, listCases) and must never be persisted — a stored copy is a second
 * representation of the same fact, free to drift from the computed one and then survive a
 * bundle round-trip as a lie. JSON.stringify omits undefined-valued keys, so setting them
 * here is the whole mechanism (Finding 7).
 *
 * Every case.json write goes through this. Adding a derived field to CaseRecord means adding
 * it here, once, instead of to nine hand-written spreads.
 */
export function stripDerived(rec: Partial<CaseRecord>): Record<string, unknown> {
  return {
    ...rec,
    id: undefined,
    phase: undefined,
    actionItems: undefined,
    lastWorkedAt: undefined
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
      `INSERT INTO cases (slug, title, jira_key, ticket_provider, status, resolution, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', NULL, '[]', ?, ?)`
    )
    .run(input.slug, input.title, input.jiraKey ?? null, input.ticketProvider ?? 'jira', now, now)

  const id = Number(res.lastInsertRowid)
  const dir = caseDir(argusHome, input.slug)

  try {
    for (const sub of ['evidence/.meta', 'artifacts/.meta', 'sessions', '.rca']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true })
    }
    const rec: CaseRecord = {
      id,
      slug: input.slug,
      origin: 'user',
      reviewState: null,
      title: input.title,
      jiraKey: input.jiraKey ?? null,
      ticketProvider: input.ticketProvider ?? 'jira',
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
      actionItems: [],
      lastWorkedAt: null,
      archivedAt: null,
      archivePath: null,
      lastOpenedAt: null
    }
    fs.writeFileSync(
      path.join(dir, 'case.json'),
      // Derived fields are never stored — see stripDerived.
      JSON.stringify(stripDerived(rec), null, 2)
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

/**
 * Five grouped reads that populate a CaseSignals per case: the evidence count (its own
 * unfiltered query, feeding only the `idle` triage item) plus four signal reads — evidence
 * timestamps split by review/investigation directory, turns split by session mode, findings
 * split by session mode, and PR-binding timestamps.
 *
 * `caseId` scopes it to one case for getCase; omitted, it covers the whole table for
 * listCases. A turn's or finding's mode comes from `sessions.mode`, which is stamped at
 * session creation and never changes; sessions predating that column COALESCE to
 * `investigation`, matching how findings.ts already derives finding mode.
 *
 * The evidence signal (unlike evidenceCount) excludes every Jira-origin row — ticket
 * mirror, attachment, or zip-extracted file alike — because all of it is ingestion output,
 * not something the user did; see the inline comment on that query for the full rule.
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

  // The phase SIGNAL, unlike the count above, is scoped by directory and excludes ALL
  // Jira-origin evidence:
  //   - directory scope: review evidence (artifacts/…, see ARTIFACTS_LIKE — mirrors
  //     shared/evidenceScope.ts's scopeOfRelPath) feeds a new lastReviewEvidenceAt signal
  //     -> `reviewing` instead of falling into lastEvidenceAt -> `analyzing`. A CI log
  //     fetched mid-review (ciLogs.ts's fetch_check_logs) is the motivating case (Finding I1).
  //   - Jira-origin exclusion: every Jira ingest path (jiraCases.ts — the ticket-mirror
  //     files, an attachment, a file exploded out of a zip attachment) stamps origin 'jira',
  //     and none of it is the user's own work — it is synchronisation/ingest output, so
  //     background sync (or ticking an attachment into the case) must never move the phase
  //     (product reversal, this pass; previously only ticket-mirror rows — identified by
  //     meta.jira.role — were excluded, on the now-rejected theory that choosing an
  //     attachment was investigation work). `origin` alone is the discriminator; no meta
  //     shape needs inspecting.
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

/**
 * Last agent activity, from the turn signals `readCaseSignals` already collects.
 *
 * Deliberately turns only — not evidence, not findings, not `pr_bindings`. Evidence lands from
 * Jira ingest and CI log fetches, and findings are written BY a turn, so both would either
 * report work the user did not do or report the same turn twice. It is also mode-blind on
 * purpose: investigation and review are both work on the case.
 *
 * Both inputs are `MAX(turns.created_at)` per mode, so this is the max over all modes. It reads
 * every field of CaseSignals that is a turn timestamp; a third mode (modes.ts anticipates one)
 * adds a field here too.
 */
function lastWorkedFrom(sig: CaseSignals): string | null {
  const seen = [sig.lastInvestigationAt, sig.lastReviewAt].filter((t): t is string => t !== null)
  return seen.length === 0 ? null : seen.reduce((a, b) => (a > b ? a : b))
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
    return {
      ...c,
      actionItems: items,
      phase: attachPhase(c, row, sig),
      lastWorkedAt: lastWorkedFrom(sig)
    }
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

/**
 * Looks up a case by its bound Jira key.
 *
 * This is what lets a routine's `jira-jql` scope ADOPT a ticket the user already opened by hand
 * instead of duplicating it: `jiraCases.createFromTicket` takes a caller-supplied slug and would
 * happily insert a second case for the same key, so the scope resolver (main/index.ts) must check
 * here first (scopeResolver.ts's `ingestJiraItem`).
 */
export function findCaseByJiraKey(db: DatabaseSync, key: string): CaseRecord | null {
  const row = db.prepare(`SELECT * FROM cases WHERE jira_key = ?`).get(key) as unknown as
    CaseRow | undefined
  if (!row) return null
  const c = rowToCase(row)
  const sig = readCaseSignals(db, c.id).get(c.id) ?? emptySignals()
  return { ...c, phase: attachPhase(c, row, sig) }
}

/**
 * Classifies an existing case.
 *
 * A setter rather than a `createCase` parameter, deliberately: the routines engine does
 * `getCase(slug) ?? createCase(...)`, so an origin passed at creation would mark only the cases
 * a routine created itself and miss every case it adopted — and the one-time backfill in db.ts
 * never revisits them. One call after get-or-create is correct on both branches.
 *
 * Idempotent. Does not touch `updated_at`: origin is a classification, not activity.
 */
export function ensureCaseOrigin(db: DatabaseSync, slug: string, origin: CaseOrigin): void {
  db.prepare(`UPDATE cases SET origin = ? WHERE slug = ?`).run(origin, slug)
}

/**
 * Record that a case was opened. Deliberately does NOT touch `updated_at`: that column is a
 * modification timestamp, and several paths in this file already avoid moving it for the same
 * reason (`ensureCaseOrigin`, `setCaseReviewState`). Plan B's archiving eligibility reads both,
 * and conflating them would make merely viewing a case indistinguishable from editing it.
 *
 * Silent on an unknown slug: this is fire-and-forget telemetry from a UI event, and a case
 * deleted in another window must not turn opening a stale tab into an error dialog.
 */
export function touchCaseOpened(db: DatabaseSync, slug: string): void {
  db.prepare(`UPDATE cases SET last_opened_at = ? WHERE slug = ?`).run(
    new Date().toISOString(),
    slug
  )
}

export interface JiraBinding {
  key: string
  site: string
  lastSyncedAt: string
}

/** Link/refresh the Jira binding: DB jira_key + a `jira` block merged into case.json. */
export function setCaseJira(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  jira: JiraBinding
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
    onDisk = stripDerived(existing)
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

export interface CaseJiraLink {
  key: string
  role: 'source'
  addedAt: string
  /** Last-seen attachment ids on THIS ticket; the per-source refresh diff baseline.
   *  Deliberately per-link: the case-level jiraAttachmentIds means the PRIMARY's
   *  attachments, and one shared list would let two tickets contaminate each other's diff. */
  attachmentIds: string[]
  /** Attachment ids the user explicitly declined on THIS source. Mirrors the primary's
   *  cases.jira_deselected: a declined file is offered again only as a "previously skipped"
   *  row, never as new. Distinct from attachmentIds, which records what the ticket last
   *  carried and must never gate the "new" signal. */
  deselectedIds: string[]
}

interface CaseJiraLinkRow {
  jira_key: string
  role: string
  added_at: string
  attachment_ids: string
  deselected_ids: string
}

/** Mirror the current link set into case.json, like every other case writer. */
function mirrorJiraSources(db: DatabaseSync, argusHome: string, slug: string): void {
  const dir = caseDir(argusHome, slug)
  if (!fs.existsSync(dir)) return // no case dir yet: nothing to mirror into
  const file = path.join(dir, 'case.json')
  let onDisk: Record<string, unknown>
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    // case.json is corrupt/unreadable — rebuild the rewrite base from the DB record,
    // same recovery path as setCaseJira, so a corrupted file doesn't permanently stop
    // future mirroring for this case.
    const existing = getCase(db, slug)
    onDisk = existing ? stripDerived(existing) : {}
  }
  const jiraSources = listCaseJiraLinks(db, slug).map((l) => l.key)
  fs.writeFileSync(file, JSON.stringify({ ...onDisk, jiraSources }, null, 2))
}

export function listCaseJiraLinks(db: DatabaseSync, slug: string): CaseJiraLink[] {
  const rows = db
    .prepare(
      `SELECT jira_key, role, added_at, attachment_ids, deselected_ids FROM case_jira_links
       WHERE case_id = (SELECT id FROM cases WHERE slug = ?) ORDER BY added_at, jira_key`
    )
    .all(slug) as unknown as CaseJiraLinkRow[]
  return rows.map((r) => ({
    key: r.jira_key,
    role: 'source' as const,
    addedAt: r.added_at,
    attachmentIds: JSON.parse(r.attachment_ids || '[]') as string[],
    deselectedIds: JSON.parse(r.deselected_ids || '[]') as string[]
  }))
}

/** Idempotent: re-adding an existing link leaves its attachment_ids baseline intact.
 *
 * A ticket cannot be both the case's own ticket AND one of its sources — enforced here,
 * at the data layer, so it holds for every caller (jiraCases.ts's importSourceTicket
 * pre-checks it too, for a fail-fast error before the network round trip; this is the
 * guarantee that catches everyone else, e.g. bundle import restoring links from a
 * malformed/hand-edited case.json). */
export function addCaseJiraLink(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  key: string
): CaseJiraLink {
  const kase = getCase(db, slug)
  if (!kase) throw new Error(`Unknown case: ${slug}`)
  if (key === kase.jiraKey) {
    throw new Error(`${key} is already this case's ticket; it cannot also be a source.`)
  }
  db.prepare(
    `INSERT INTO case_jira_links (case_id, jira_key, role, added_at, attachment_ids)
     VALUES (?, ?, 'source', ?, '[]')
     ON CONFLICT(case_id, jira_key) DO NOTHING`
  ).run(kase.id, key, new Date().toISOString())
  mirrorJiraSources(db, argusHome, slug)
  return listCaseJiraLinks(db, slug).find((l) => l.key === key)!
}

export function removeCaseJiraLink(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  key: string
): void {
  db.prepare(
    `DELETE FROM case_jira_links WHERE case_id = (SELECT id FROM cases WHERE slug = ?) AND jira_key = ?`
  ).run(slug, key)
  mirrorJiraSources(db, argusHome, slug)
}

export function setCaseJiraLinkAttachmentIds(
  db: DatabaseSync,
  slug: string,
  key: string,
  ids: string[]
): void {
  db.prepare(
    `UPDATE case_jira_links SET attachment_ids = ?
     WHERE case_id = (SELECT id FROM cases WHERE slug = ?) AND jira_key = ?`
  ).run(JSON.stringify(ids), slug, key)
}

/** Persist which of a SOURCE ticket's attachments the user declined. The primary's equivalent
 *  is setCaseJiraDeselected (cases.jira_deselected); this is deliberately per-link so two
 *  tickets can never overwrite each other's decisions. */
export function setCaseJiraLinkDeselected(
  db: DatabaseSync,
  slug: string,
  key: string,
  ids: string[]
): void {
  db.prepare(
    `UPDATE case_jira_links SET deselected_ids = ?
     WHERE case_id = (SELECT id FROM cases WHERE slug = ?) AND jira_key = ?`
  ).run(JSON.stringify(ids), slug, key)
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
    onDisk = stripDerived(existing)
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
    onDisk = stripDerived(updated)
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
    onDisk = stripDerived(existing)
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
    onDisk = stripDerived(existing)
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
 * The namespace of a tag: everything before its FIRST colon, or null for a bare tag.
 *
 * First colon, not last: `owner:alice:smith` is one owner value, not a nested namespace, so it
 * competes with `owner:bob` and with nothing else.
 */
function tagNamespace(tag: string): string | null {
  const i = tag.indexOf(':')
  return i === -1 ? null : tag.slice(0, i)
}

/**
 * Folds an accepted suggestion's tags into the tags a case already carries.
 *
 * MERGE, NOT REPLACE. Replacing was the shipped behaviour and it silently destroyed whatever was
 * already on the case: two routines with overlapping scopes clobbered each other, the same
 * routine re-drafting a case clobbered its own earlier accepted tags (last Accept wins, no
 * trace), and bundle-imported tags vanished. Tags are not decoration — they feed the distill
 * prompt (distill/contract.ts) and the RCA prompt (rca/contract.ts), and they drive the `cases`
 * scope filter (routines/scopeResolver.ts), so a lost tag silently changes what future runs see.
 *
 * The rules, exactly:
 *  - A NAMESPACED incoming tag (`severity:high`) replaces every existing tag sharing its
 *    namespace, because a namespace is single-valued by construction: `severity:low` and
 *    `severity:high` on one case describe nothing.
 *  - A BARE incoming tag (`flaky`) accumulates. Nothing can say what it would replace, so it
 *    removes nothing.
 *  - Two incoming tags in ONE namespace (`severity:high` + `severity:low` from one model turn)
 *    are BOTH kept. That is the model contradicting itself, and picking a winner here would hide
 *    it; on the case both are visible and a human resolves it.
 *  - Deduplicated, so accepting the same suggestion twice (two windows, a double click) is
 *    idempotent in the data, not just in the UI.
 *  - ORDER IS DETERMINISTIC AND PART OF THE CONTRACT: surviving existing tags first, in their
 *    existing relative order, then incoming tags not already present, in the order given.
 *
 * A leading-colon tag (`:x`) has the empty string as its namespace and follows the namespaced
 * rule against other empty-namespace tags — degenerate, but defined rather than special-cased.
 */
export function mergeTags(existing: readonly string[], incoming: readonly string[]): string[] {
  const replaced = new Set<string>()
  for (const tag of incoming) {
    const ns = tagNamespace(tag)
    if (ns !== null) replaced.add(ns)
  }
  const out: string[] = []
  const seen = new Set<string>()
  const push = (tag: string): void => {
    if (seen.has(tag)) return
    seen.add(tag)
    out.push(tag)
  }
  for (const tag of existing) {
    const ns = tagNamespace(tag)
    if (ns !== null && replaced.has(ns)) continue
    push(tag)
  }
  for (const tag of incoming) push(tag)
  return out
}

/**
 * Applies an accepted routine suggestion to a case.
 *
 * Mirrors `setCaseStatus`'s shape — validate, update the row, write case.json — because these
 * are the only two writers of canonical case fields and they must not drift in how they mirror.
 *
 * A patch, not a replacement: an omitted key leaves its field alone, so accepting a suggestion
 * that proposed only tags cannot blank a title a human wrote. `tags: []` means the suggestion
 * PROPOSED NO TAGS — identical to omitting the key, never "clear the case's tags": nothing in
 * the product asks a routine to remove tags, and reading an empty proposal as a wipe would make
 * the least specific suggestion the most destructive one. Non-empty tags are folded in by
 * `mergeTags` above rather than overwriting.
 *
 * DOES NOT MOVE `updated_at`, for exactly the reason `setCaseReviewState` below does not, and it
 * is the same loop that docblock already forbids: a `cases`-scoped routine re-selects a case
 * whenever `updated_at > lastAttemptAt` (routines/items.ts). Accepting is reached only from
 * `RoutinesService.acceptItem`, which calls this and then clears the draft flag — so a bumped
 * timestamp made every accepted case look freshly modified, the next sweep re-drafted it, and
 * accepting THAT re-drafted it again, forever, burning the run's item cap while genuinely new
 * cases starved. Applying a suggestion a routine wrote is not human activity on the case; the
 * routine's own attempt is already recorded on `routine_run_items`, which is where that history
 * belongs. `acceptItem` is the only production caller (verified by grep, whole repo), so no other
 * contract changes here — a future human-facing triage path that DOES want to register activity
 * must say so explicitly rather than inherit it.
 */
export function setCaseTriage(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  patch: { title?: string; tags?: string[] }
): CaseRecord {
  const existing = getCase(db, slug)
  if (!existing) throw new Error(`Unknown case: ${slug}`)

  const title = patch.title ?? existing.title
  const tags = patch.tags ? mergeTags(existing.tags, patch.tags) : existing.tags
  // The row's own value, mirrored back into case.json below so the two cannot drift — NOT the
  // file's, which a hand edit could have moved.
  const updatedAt = existing.updatedAt

  db.prepare(`UPDATE cases SET title = ?, tags = ? WHERE slug = ?`).run(
    title,
    JSON.stringify(tags),
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
    onDisk = stripDerived(existing)
  }
  fs.writeFileSync(file, JSON.stringify({ ...onDisk, title, tags, updatedAt }, null, 2))
  return getCase(db, slug)!
}

/**
 * Marks or unmarks a case as a routine's unreviewed draft.
 *
 * Does NOT touch `updated_at`, for the same reason `ensureCaseOrigin` does not: review state is
 * a classification, not activity on the case. Moving the timestamp here would also re-select the
 * case in a `cases`-scoped sweep on the next run, which is a loop.
 */
export function setCaseReviewState(db: DatabaseSync, slug: string, state: CaseReviewState): void {
  db.prepare(`UPDATE cases SET review_state = ? WHERE slug = ?`).run(state, slug)
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
    onDisk = stripDerived(existing)
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
 *
 * That checkout is STARTED here but not awaited, and the returned `materialized` promise is
 * the handle on it. Awaiting it put a network round trip on the critical path of every
 * review-mode entry with a PR already bound: `ensurePrWorktree` probes `git ls-remote
 * origin refs/pull/N/head` (~1.5s measured) before it can even decide whether a fetch is
 * needed, and a moved head then costs the fetch too. The switch itself is a DB `UPDATE` and
 * a `case.json` write — which is why investigation mode is instant and review was not — and
 * none of what this function returns depends on the worktree existing. Callers that want to
 * act on the checkout (main/index.ts broadcasts `workspacesChanged` again when it lands, so
 * repo chips see the new worktree) chain onto `materialized`; it never rejects.
 */
export async function setCaseMode(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  mode: ModeId,
  provider: SessionProvider,
  opts?: { materialize?: PrMaterializer }
): Promise<{ sessionId: number; materialized: Promise<void> }> {
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
    onDisk = stripDerived(existing)
  }
  fs.writeFileSync(file, JSON.stringify({ ...onDisk, activeMode: mode, updatedAt: now }, null, 2))

  const materialized =
    mode === 'review' && opts?.materialize
      ? materializePrBindings(db, argusHome, slug, opts.materialize).catch((err) => {
          console.warn(
            `[pr] materialize on review entry for ${slug} failed: ${(err as Error).message}`
          )
        })
      : Promise.resolve()

  const target = latestSessionForMode(db, slug, mode)
  if (target) return { sessionId: target.id, materialized }
  const created = createSession(db, slug, { ...provider, mode })
  return { sessionId: created.id, materialized }
}

/**
 * The frozen-case half of `deleteCase`'s precondition, as ONE definition both the function and
 * its IPC caller share.
 *
 * `cases:delete` opens by stopping every live session for the case and tearing down its file
 * watcher — irreversible side effects — and only then calls `deleteCase`. When `deleteCase`
 * refuses a frozen case, those side effects have already happened: the user's chats are dead
 * and the watcher is gone, and the delete they asked for did not occur. So the handler has to
 * ask this question FIRST. Exported rather than re-inlined there because a second copy of the
 * rule (and its message) is precisely the two-representations drift this codebase keeps paying
 * for: change the rule here and both callers move together.
 *
 * Deliberately NOT `assertCaseWritable` — see `deleteCase`'s docblock for why an ARCHIVED case
 * must stay deletable.
 */
export function assertCaseDeletable(slug: string): void {
  if (isCaseFrozen(slug)) {
    throw new Error(
      `Case ${slug} is being archived. Wait for that operation to finish before deleting it.`
    )
  }
}

/**
 * Hard-delete a case. Order: FTS rows (evidence_fts/messages_fts have no FK — the
 * evidence map lookup joins evidence rows, so clean it BEFORE the cascade destroys
 * those rows) → cases row (FK cascade takes evidence/sessions/turns/tool_calls/
 * findings; their case_id columns are now indexed) → distill
 * tables (case_summaries, case_summaries_fts, distill_jobs) and rca_jobs — all keyed by
 * case_slug, not case_id, so the cascade above doesn't touch them → audit →
 * case directory → dev-tools prompt capture directory (best-effort; a captured
 * systemAppend includes the persona, pack fragments and the agent-access-filtered
 * memory index, so a deleted case's prompt text must not survive it) → archive bundle
 * (opt-in via `opts.deleteArchive`; the bundle lives outside caseDir under
 * `<argusHome>/archive`, so it is retained by default — the audit's `archiveRetained`
 * field records which way it went either way). Callers must first stop live sessions
 * (AgentService.stopAllForCase) and close the case's file watcher. rmSync removes the
 * .claude junctions as links, never their targets.
 *
 * Refuses a FROZEN case, but deliberately does NOT call `assertCaseWritable` (which would
 * also refuse an ARCHIVED case): archiving a case only to make it permanently undeletable
 * would defeat the reason this function takes `opts.deleteArchive` at all. The two states
 * need different answers. `archiveCase` holds its freeze across `await` points (export,
 * then a verify pass that can take seconds to minutes) before its own transaction commits;
 * without this check, a concurrent `deleteCase` for the same slug can run to completion
 * while an archive is suspended mid-freeze — cascade-deleting the `cases` row and the case
 * dir, and possibly the bundle too, out from under an archive that is about to `UPDATE
 * cases … WHERE id = ?` and rename its verified zip into place. That archive then "succeeds"
 * against a case that no longer exists, and can even race `deleteCase(..., { deleteArchive:
 * true })`'s bundle removal and leave the orphaned bundle back on disk. A freeze is always
 * transient (seconds to minutes), so refusing during it makes nothing permanently
 * undeletable — unlike gating on `assertCaseWritable`, which would.
 */
export function deleteCase(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  opts: { deleteArchive?: boolean } = {}
): void {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid case slug: ${JSON.stringify(slug)}`)
  assertCaseDeletable(slug)
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
    findings: count('findings'),
    // Recorded either way: an audit line saying "case deleted" while several hundred MB of
    // its evidence still sits in archive/ is a false record.
    archiveRetained: !opts.deleteArchive
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
    db.prepare(`DELETE FROM rca_jobs WHERE case_slug = ?`).run(slug)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  appendDeletionAudit(argusHome, 'case.delete', slug, detail)
  fs.rmSync(caseDir(argusHome, slug), { recursive: true, force: true })
  // The bundle is a SECOND home for this case's bytes, outside caseDir, so removing the case
  // dir alone would orphan it — a multi-hundred-megabyte file with no row pointing at it and
  // nothing left to restore it into. Removing it is opt-in: "case gone from Argus, archive
  // kept" is a legitimate outcome the caller chooses.
  if (opts.deleteArchive) {
    fs.rmSync(caseArchivePath(argusHome, slug), { force: true })
  }
  // Best-effort: case deletion is the more important operation, so a failure to remove the
  // capture directory (locked file, permissions) must not surface as a failed case deletion.
  try {
    fs.rmSync(path.join(argusHome, CAPTURE_DIR_REL, slug), { recursive: true, force: true })
  } catch (err) {
    console.warn(`[prompts] failed to remove capture directory for deleted case ${slug}:`, err)
  }
}
