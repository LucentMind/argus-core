import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CaseDistillInput } from '../../../shared/distill'
import type { RcaDraft } from '../../../shared/rca'
import { getCase } from '../caseService'
import { listFindings } from '../findings'
import { listEvidence } from '../ingest'
import { listSessions } from '../agent/sessionStore'
import { listProposals, listArchivedProposals } from '../proposals'
import { refTitle, refBody, refTier } from '../refSync/refFrontmatter'
import { sharedReferencesDir } from '../skillsDir'
import { artifactsDir } from '../paths'
import { buildWorld, clampText } from './world'

/** Per-session cap on verbatim user turns fed to the agentic distiller's raw-quote source. */
export const USER_MSGS_PER_SESSION = 25
/** Overall cap across all sessions, newest session first. */
export const USER_MSGS_TOTAL = 100
/** Head 3 000 + tail 1 000 (clampText's 6000/8000 head:cap ratio scales to this). */
export const USER_MSG_CLAMP = 4_000

/** Reference name/summary/content/tier records for the shared references/ dir — summary is the
 *  first trimmed, non-blank, non-heading line of the body (matching generateReferencesIndex in
 *  refSync/engine.ts), falling back to the frontmatter title when no such line exists; content
 *  is the full raw file (frontmatter + body) a reference-edit must return with its change
 *  merged in; tier is the trust_tier ('confluence' files are auto-synced and must never be an
 *  edit target — the distiller is told so via rule 7). */
/*
 * FLAT ON PURPOSE — do not "fix" this to use listReferenceFiles.
 *
 * This enumeration feeds the distiller, whose only output for a reference is a `reference-edit`
 * proposal. That proposal's target must satisfy ASSET_NAME_RE (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
 * no separator), re-checked in acceptProposal. Listing a nested reference here would let the
 * distiller propose an edit whose accept then throws `Invalid proposal target` — strictly worse
 * than not offering it. Nested references are read-only by design: they are visible in the
 * Library, INDEX.md, search, usage stats and the agent prompt, and editable nowhere.
 */
export function buildReferencesIndex(
  argusHome: string
): { name: string; summary: string; content: string; tier: string | null }[] {
  const dir = sharedReferencesDir(argusHome)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.') && f !== 'INDEX.md')
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8')
      const bodyLine = refBody(raw)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'))
      return {
        name: f.replace(/\.md$/, ''),
        summary: bodyLine ?? refTitle(raw) ?? '',
        content: raw,
        tier: refTier(raw)
      }
    })
}

/**
 * `artifacts/rca-structure.json` — the confirmed, human-reviewed RCA structure for this case, if
 * one was ever generated and confirmed. Unlike rca/jobs.ts's readPriorDraft (which throws on a
 * corrupt file so a bad read can never silently regenerate over confirmed edits), this read is
 * purely advisory input to a case distillation — which can run on a live (open) case as well as
 * a closed one: a missing file, an unreadable one, or malformed JSON all just mean "no confirmed
 * structure to fold in" — never throw, always fall back to null.
 */
function readConfirmedRcaStructure(argusHome: string, slug: string): RcaDraft | null {
  const file = path.join(artifactsDir(argusHome, slug), 'rca-structure.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RcaDraft
  } catch {
    return null
  }
}

/** Verbatim user turns, newest sessions first, last `USER_MSGS_PER_SESSION` per session,
 *  capped overall at `USER_MSGS_TOTAL`. Sessions with zero user turns are skipped entirely
 *  (not represented as an empty group). Queries `messages_fts` directly — deliberately NOT
 *  `listSessions()`, which CREATES a session when none exist (see world.ts's buildWorld for
 *  the same idiom); a snapshot must never mutate the case it snapshots. */
function collectUserMessages(
  db: DatabaseSync,
  caseId: number
): { sessionTitle: string; messages: string[] }[] {
  const sess = db
    .prepare(`SELECT id, title FROM sessions WHERE case_id = ? ORDER BY id DESC`)
    .all(caseId) as { id: number; title: string }[]
  const out: { sessionTitle: string; messages: string[] }[] = []
  let total = 0
  for (const s of sess) {
    if (total >= USER_MSGS_TOTAL) break
    const rows = db
      .prepare(
        `SELECT content FROM messages_fts WHERE case_id = ? AND session_id = ? AND role = 'user' ORDER BY rowid ASC`
      )
      .all(caseId, s.id) as { content: string }[]
    if (rows.length === 0) continue
    const take = Math.min(USER_MSGS_PER_SESSION, USER_MSGS_TOTAL - total)
    const msgs = rows.slice(-take).map((r) => clampText(r.content, USER_MSG_CLAMP).text)
    total += msgs.length
    out.push({ sessionTitle: s.title, messages: msgs })
  }
  return out
}

/** One-line steer for a skill/reference index entry whose most recent edit proposal was
 *  rejected — deliberately cross-case: the whole point is to warn the distiller off repeating
 *  a mistake a *different* case's proposal already made against this same asset. */
function rejectionNote(p: {
  caseSlug: string
  rejectReason?: string
  rejectNote?: string
}): string {
  const base = `a proposed edit here was rejected as ${p.rejectReason ?? 'unspecified'} (case ${p.caseSlug})`
  return p.rejectNote ? `${base}: ${p.rejectNote}` : base
}

/** `type target` -> one-line rejection note, across ALL cases. Sorted ascending by `rejectedAt`
 *  (when the REJECT itself happened, stamped by rejectProposal) -- falling back to `date`
 *  (proposal CREATION time) only for legacy archive rows written before `rejected_at` existed --
 *  before the map is built, so a later Map.set for the same key overwrites an earlier one and
 *  the note from the MOST RECENTLY REJECTED proposal survives. `date` alone says nothing about
 *  when the rejection happened and must never be the primary sort key. */
function buildRejectAnnotations(
  archivedAll: ReturnType<typeof listArchivedProposals>
): Map<string, string> {
  const rejected = archivedAll
    .filter((p) => p.status === 'rejected')
    .sort((a, b) => (a.rejectedAt ?? a.date).localeCompare(b.rejectedAt ?? b.date))
  const map = new Map<string, string>()
  for (const p of rejected) map.set(`${p.type} ${p.target}`, rejectionNote(p))
  return map
}

/**
 * Snapshot everything the background distiller needs to draft a case's proposals:
 * case meta, findings with review states and roles, evidence inventory, session
 * titles, skills/references index (annotated with reject notes where a prior edit
 * to that same asset was rejected, in this case or another), the confirmed RCA
 * structure (if any), the already-captured section (pending + archived proposals
 * for this case) so the distiller can skip re-proposing what a human already
 * reviewed, a frozen world snapshot (v2 tools), verbatim user turns, and any
 * operator guidance supplied at enqueue time.
 */
export function assembleDistillInput(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  skillsIndex: { name: string; description: string; content: string }[] = [],
  opts: { operatorGuidance?: string } = {}
): CaseDistillInput {
  const c = getCase(db, slug)
  if (!c) throw new Error(`Unknown case: ${slug}`)

  const pending = listProposals(argusHome)
    .filter((p) => p.caseSlug === slug)
    .map((p) => ({ type: p.type, target: p.target, title: p.title, state: 'pending' as const }))
  const archivedAll = listArchivedProposals(argusHome)
  const archived = archivedAll
    .filter((p) => p.caseSlug === slug)
    .map((p) => ({ type: p.type, target: p.target, title: p.title, state: p.status }))

  const rejectAnnotations = buildRejectAnnotations(archivedAll)
  const skillsIndexOut = skillsIndex.map((s) => {
    const note = rejectAnnotations.get(`skill-edit ${s.name}`)
    return note ? { ...s, note } : s
  })
  const referencesIndexOut = buildReferencesIndex(argusHome).map((r) => {
    const note = rejectAnnotations.get(`reference-edit ${r.name}`)
    return note ? { ...r, note } : r
  })

  return {
    caseMeta: {
      slug: c.slug,
      title: c.title,
      jiraKey: c.jiraKey,
      status: c.status,
      resolution: c.resolution,
      tags: c.tags,
      createdAt: c.createdAt,
      closedAt: c.updatedAt
    },
    findings: listFindings(db, argusHome, slug).map((f) => ({
      id: f.id,
      summary: f.summary,
      reviewState: f.reviewState,
      role: f.role,
      body: f.body ?? ''
    })),
    evidence: listEvidence(db, slug).map((e) => ({
      relPath: e.relPath,
      artifactType: e.artifactType,
      size: e.size
    })),
    sessionTitles: listSessions(db, slug).map((s) => s.title),
    skillsIndex: skillsIndexOut,
    referencesIndex: referencesIndexOut,
    rcaStructure: readConfirmedRcaStructure(argusHome, slug),
    alreadyCaptured: {
      proposals: [...pending, ...archived]
    },
    world: buildWorld(db, slug),
    userMessages: collectUserMessages(db, c.id),
    ...(opts.operatorGuidance !== undefined ? { operatorGuidance: opts.operatorGuidance } : {})
  }
}
