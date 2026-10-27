import type { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import {
  isFindingRole,
  isFindingRejectTag,
  isFindingStatus,
  isRoleSource,
  type FindingRejectReason,
  type FindingRow,
  type RetractResult,
  type ReviewState,
  type ReviewActor
} from '../../shared/observability'
import { isReviewLayerId, isReviewSeverity } from '../../shared/reviewLayers'
import { DEFAULT_MODE, type ModeId } from '../../shared/modes'
import type { RoleAssignment } from '../../shared/rca'
import type { FindingPatch, UpdateResult } from '../../shared/findingPatch'
import { caseDir } from './paths'
import { getCase } from './caseService'
import { appendDeletionAudit } from './deletionAudit'
import { overrideFromRetraction, overrideFromFindingReject } from './distill/overrides'
import type { AttributionRow } from '../../shared/attribution'

export type { FindingRow, ReviewState, FindingPatch, UpdateResult }
const REVIEW_STATES: ReviewState[] = ['pending', 'accepted', 'rejected']
// Non-global, so it is safe to share between the two `split` call sites below.
const FINDING_MARKER_SPLIT = /<!-- finding:(\d+) -->/

interface Raw {
  id: number
  case_id: number
  session_id: number | null
  turn_id: number | null
  summary: string
  review_state: string
  reviewed_at: string | null
  created_at: string
  layer: string | null
  severity: string | null
  diff_path: string | null
  diff_line: number | null
  suggested_change: string | null
  comment_url: string | null
  pushed_sha: string | null
  comment_body: string | null
  head_sha: string | null
  mode: string | null
  role: string | null
  review_reason: string | null
  review_actor: string | null
  reject_tag: string | null
  reject_note: string | null
  status: string | null
  role_source: string | null
  caused_by: number | null
  superseded_by: number | null
}

function toRow(r: Raw): FindingRow {
  return {
    id: r.id,
    caseId: r.case_id,
    sessionId: r.session_id,
    turnId: r.turn_id,
    summary: r.summary,
    reviewState: r.review_state as ReviewState,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
    layer: isReviewLayerId(r.layer) ? r.layer : null,
    severity: isReviewSeverity(r.severity) ? r.severity : null,
    diffPath: r.diff_path,
    diffLine: r.diff_line,
    suggestedChange: r.suggested_change,
    commentUrl: r.comment_url,
    pushedSha: r.pushed_sha,
    commentBody: r.comment_body ?? null,
    headSha: r.head_sha ?? null,
    // A finding whose session was deleted, or one written before the mode axis, has no mode
    // to join — it is investigation by the same rule that made investigation the implicit
    // default for every pre-existing case (spec §3).
    mode: (r.mode as ModeId | null) ?? DEFAULT_MODE,
    role: isFindingRole(r.role) ? r.role : null,
    reviewReason: r.review_reason,
    // Anything other than the literal 'agent' — including NULL on every pre-retraction row,
    // and on a reset to `pending` — takes the same path as the human review path, which is
    // what `toRow` here actually returns: `null` is preserved, not mapped to 'human'.
    reviewActor: (r.review_actor === 'agent'
      ? 'agent'
      : r.review_actor
        ? 'human'
        : null) as ReviewActor | null,
    rejectTag: isFindingRejectTag(r.reject_tag) ? r.reject_tag : null,
    rejectNote: r.reject_note ?? null,
    status: isFindingStatus(r.status) ? r.status : 'confirmed',
    // Source only means something beside a role: a stray source on a role-less row is noise.
    roleSource: isFindingRole(r.role) && isRoleSource(r.role_source) ? r.role_source : null,
    causedBy: r.caused_by ?? null,
    supersededBy: r.superseded_by ?? null
  }
}

// A finding's mode is derived by joining sessions.mode (never stored on the finding row
// itself), so every finding read goes through this LEFT JOIN. LEFT is load-bearing: an
// inner join would drop every session-less finding (deleted session, or pre-mode-axis rows).
const FINDINGS_WITH_MODE = `findings f LEFT JOIN sessions s ON s.id = f.session_id`

/** Parse findings.md into an id→body map using the `<!-- finding:{id} -->`
 *  markers appendFinding writes. Body is the markdown after the `## title` and
 *  `_meta_` lines. Findings written before markers existed simply won't match. */
export function parseFindingBodies(md: string): Map<number, string> {
  const map = new Map<number, string>()
  const parts = md.split(FINDING_MARKER_SPLIT)
  // parts = [before, id1, segment1, id2, segment2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const id = Number(parts[i])
    const body = stripHeadingAndMeta(parts[i + 1] ?? '')
    if (body) map.set(id, body)
  }
  return map
}

function stripHeadingAndMeta(segment: string): string {
  const lines = segment.split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++ // leading blanks
  if (i < lines.length && lines[i].startsWith('## ')) i++ // heading
  if (i < lines.length && /^_.*_$/.test(lines[i].trim())) i++ // meta line
  return lines.slice(i).join('\n').trim()
}

export function listFindings(db: DatabaseSync, argusHome: string, caseSlug: string): FindingRow[] {
  const rows = (
    db
      .prepare(
        `SELECT f.*, s.mode AS mode FROM ${FINDINGS_WITH_MODE}
         JOIN cases c ON c.id = f.case_id
         WHERE c.slug = ?
         ORDER BY CASE f.role
           WHEN 'root-cause' THEN 0 WHEN 'contributing' THEN 1 WHEN 'symptom' THEN 2
           WHEN 'duplicate' THEN 3 WHEN 'ruled-out' THEN 4 ELSE 5 END, f.id DESC`
      )
      .all(caseSlug) as unknown as Raw[]
  ).map(toRow)
  let bodies = new Map<number, string>()
  try {
    const md = fs.readFileSync(path.join(caseDir(argusHome, caseSlug), 'findings.md'), 'utf8')
    bodies = parseFindingBodies(md)
  } catch {
    // no findings.md yet (or unreadable) → cards render body-less
  }
  return rows.map((r) => {
    const body = bodies.get(r.id)
    return body ? { ...r, body } : r
  })
}

/** The `rejectProposal` note rule: first non-blank line, trimmed, at most 200 chars; null when
 *  there is nothing left. */
export function firstNoteLine(note: string | undefined): string | null {
  const line = (note ?? '')
    .split(/\r\n|\r|\n/)
    .find((l) => l.trim())
    ?.trim()
    .slice(0, 200)
  return line || null
}

/** IPC-boundary validation of a reject reason. `undefined`/`null` mean "no reason" (the plain
 *  thumb). Anything else must be `{ tag: <FindingRejectTag>, note?: string }` or this throws —
 *  before any write, so the finding keeps its previous state. */
export function parseFindingRejectReason(v: unknown): FindingRejectReason | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object') throw new Error(`Invalid reject reason: ${JSON.stringify(v)}`)
  const { tag, note } = v as { tag?: unknown; note?: unknown }
  if (!isFindingRejectTag(tag)) throw new Error(`Invalid reject tag: ${JSON.stringify(tag)}`)
  if (note !== undefined && typeof note !== 'string')
    throw new Error(`Invalid reject note: ${JSON.stringify(note)}`)
  return note === undefined ? { tag } : { tag, note }
}

export function reviewFinding(
  db: DatabaseSync,
  id: number,
  state: ReviewState,
  reason?: FindingRejectReason,
  opts: { onOverride?: (row: AttributionRow) => void } = {}
): FindingRow | null {
  if (!REVIEW_STATES.includes(state))
    throw new Error(`Invalid review state: ${JSON.stringify(state)}`)
  const reviewedAt = state === 'pending' ? null : new Date().toISOString()
  // A reset to `pending` has no reviewer — clear the actor. An accept/reject stamps the
  // human as the actor. `review_reason` is deliberately left untouched here: it is the only
  // record of WHAT was wrong with a finding (retractFinding is the sole writer of it, and
  // the v3 dossier contract treats it as the record of how a hypothesis was ruled out), and
  // attribution is governed entirely by `review_actor`, not by whether the reason column
  // still holds text. FindingCard and reviewTag() both gate the label AND the reason on
  // `reviewActor === 'agent'` — once a human's click makes the actor 'human' (or a reset to
  // pending makes it null), the old reason is invisible at every display/prompt site
  // regardless of whether the column still has it. Clearing it here would just destroy the
  // agent's stated reasoning with no undo and no audit trail, for no visible benefit.
  const reviewActor = state === 'pending' ? null : 'human'
  // The human's label (spec 2026-10-25 §4.2): a reject WITH a reason writes it; a reject
  // WITHOUT one leaves whatever label is there (the plain thumb never wipes a label, so a fresh
  // reject of a pending row lands NULL/NULL); accept and pending clear both.
  const note = reason ? firstNoteLine(reason.note) : null
  if (state === 'rejected' && reason) {
    db.prepare(
      `UPDATE findings SET review_state = ?, reviewed_at = ?, review_actor = ?, reject_tag = ?, reject_note = ? WHERE id = ?`
    ).run(state, reviewedAt, reviewActor, reason.tag, note, id)
  } else if (state === 'rejected') {
    db.prepare(
      `UPDATE findings SET review_state = ?, reviewed_at = ?, review_actor = ? WHERE id = ?`
    ).run(state, reviewedAt, reviewActor, id)
  } else {
    db.prepare(
      `UPDATE findings SET review_state = ?, reviewed_at = ?, review_actor = ?, reject_tag = NULL, reject_note = NULL WHERE id = ?`
    ).run(state, reviewedAt, reviewActor, id)
  }
  // Spec 2026-10-25 §4.2/§4.6: the override sits ON the write. Only `wrong` with a stored note
  // says anything about an asset; a failure here is logged and never fails the review.
  if (state === 'rejected' && reason?.tag === 'wrong' && note) {
    try {
      const overridden = overrideFromFindingReject(db, id, note)
      if (overridden) opts.onOverride?.(overridden)
    } catch (err) {
      console.error('[attribution] finding-reject override failed', err)
    }
  }
  const row = db
    .prepare(`SELECT f.*, s.mode AS mode FROM ${FINDINGS_WITH_MODE} WHERE f.id = ?`)
    .get(id) as unknown as Raw | undefined
  return row ? toRow(row) : null
}

export type { RetractResult }

/**
 * The agent withdrawing its own finding. Folds into the existing `rejected` state — a
 * retraction and a human reject land on the same state — and records WHO and WHY in
 * `review_actor` / `review_reason`.
 *
 * Two rules the caller cannot enforce for itself:
 *  - An `accepted` finding is refused outright. A human's accept is not the agent's to
 *    overturn; disagreement belongs in chat, not in a silent state flip.
 *  - A finding a HUMAN already rejected is left exactly as it is (`changed: false`). The
 *    call still succeeds, because the finding is already in the state the agent wanted —
 *    but the human's reason and authorship survive. An agent's own earlier retraction IS
 *    overwritten: the newer reason is the better one.
 *
 * Returns a result rather than throwing so this module needs no prompt-registry resolver;
 * the tool layer owns the user-facing wording.
 *
 * `opts.actor` (default `'agent'`) names who is retracting. A rewind passes `'human'`: the
 * user's gesture discarded the turn that produced the finding, so the retraction is theirs,
 * not the agent's — and the display gates keyed on `reviewActor === 'agent'` must therefore
 * render it as a plain rejection rather than attributing a reason to the model.
 */
export function retractFinding(
  db: DatabaseSync,
  id: number,
  reason: string,
  opts: {
    actor?: 'agent' | 'human'
    onOverride?: (row: AttributionRow) => void
    /** Fired with the updated row only when the retraction actually changed it (never for a
     *  finding a human already rejected). The tool handler and the dev IPC score it. */
    onRetracted?: (row: FindingRow) => void
  } = {}
): RetractResult {
  const cur = db.prepare(`SELECT review_state, review_actor FROM findings WHERE id = ?`).get(id) as
    { review_state: string; review_actor: string | null } | undefined
  if (!cur) return { ok: false, reason: 'unknown' }
  if (cur.review_state === 'accepted') return { ok: false, reason: 'accepted' }
  const humanRejected = cur.review_state === 'rejected' && cur.review_actor !== 'agent'
  if (!humanRejected) {
    db.prepare(
      `UPDATE findings
          SET review_state = 'rejected', review_actor = ?, review_reason = ?, reviewed_at = ?
        WHERE id = ?`
    ).run(opts.actor ?? 'agent', reason, new Date().toISOString(), id)
    // Spec §4.7: a retraction that names an asset of the case is an implicit human-grade
    // override. Only when the row actually changed; a failure here never fails the retraction.
    try {
      const overridden = overrideFromRetraction(db, id, reason)
      if (overridden) opts.onOverride?.(overridden)
    } catch (err) {
      console.error('[attribution] retraction override failed', err)
    }
  }
  const row = toRow(
    db
      .prepare(`SELECT f.*, s.mode AS mode FROM ${FINDINGS_WITH_MODE} WHERE f.id = ?`)
      .get(id) as unknown as Raw
  )
  if (!humanRejected) {
    try {
      opts.onRetracted?.(row)
    } catch (err) {
      console.error('[findings] onRetracted failed', err)
    }
  }
  return { ok: true, row, changed: !humanRejected }
}

/** The `### Update <iso>` section `update_finding(append_markdown)` adds to a finding's block.
 *  Same marker grammar as `removeFindingBodies`; a finding whose block is missing from
 *  findings.md (a legacy row) gets a fresh block so the update is not lost. Pure. */
export function appendToFindingBody(
  md: string,
  id: number,
  text: string,
  summary: string,
  now: Date = new Date()
): string {
  const iso = now.toISOString()
  const section = `### Update ${iso}\n\n${text.trim()}\n`
  const parts = md.split(FINDING_MARKER_SPLIT)
  for (let i = 1; i < parts.length; i += 2) {
    if (Number(parts[i]) !== id) continue
    parts[i + 1] = `${(parts[i + 1] ?? '').replace(/\s+$/, '')}\n\n${section}${
      i + 2 < parts.length ? '\n' : ''
    }`
    let out = parts[0]
    for (let j = 1; j < parts.length; j += 2)
      out += `<!-- finding:${parts[j]} -->${parts[j + 1] ?? ''}`
    return out
  }
  return `${md.replace(/\s+$/, '')}\n\n<!-- finding:${id} -->\n## ${summary}\n_${iso}_\n\n${section}`
}

/** The case's one ACTIVE confirmed root cause (role root-cause, status confirmed or legacy NULL,
 *  not rejected, not superseded), or null. `exceptId` excludes the finding being updated (or,
 *  for `append_finding(supersedes)`, the one about to be retracted). Investigation findings
 *  only: the chain is an investigation concept, so a review-mode (PR) row — which no
 *  investigation session can see, let alone supersede — never counts as the case's root. Mode
 *  is joined the same way every finding read derives it (FINDINGS_WITH_MODE; no session row
 *  reads as investigation). */
export function confirmedRootCauseOf(
  db: DatabaseSync,
  caseId: number,
  exceptId = -1
): number | null {
  const other = db
    .prepare(
      `SELECT f.id AS id FROM ${FINDINGS_WITH_MODE}
        WHERE f.case_id = ? AND f.id != ? AND f.role = 'root-cause'
          AND COALESCE(f.status, 'confirmed') = 'confirmed'
          AND f.review_state != 'rejected' AND f.superseded_by IS NULL
          AND COALESCE(s.mode, 'investigation') = 'investigation'
        ORDER BY f.id LIMIT 1`
    )
    .get(caseId, exceptId) as { id: number } | undefined
  return other?.id ?? null
}

/**
 * The single writer of a finding's chain fields (spec 2026-10-26 §5.1): `status`, `role` (+
 * `role_source` = the actor), `caused_by`, and the body append. Both the agent's
 * `update_finding` and the human's card editor land here, so every invariant is checked once,
 * in one order, before anything is written:
 *   unknown / empty → review-mode → accepted-locked, rca-frozen (agent only) → self-cause,
 *   bad-cause, cycle → second-root. A refusal is a RESULT, not a throw — the tool layer and
 *   the IPC own the wording. Invalid enum values are a caller bug and throw.
 * A rejected or superseded confirmed root cause is ruled out and does not block a new one.
 * Order of writes: DB row first, findings.md second — a crash between them leaves a correct row
 * missing an evidence paragraph, never a body that claims a change the row does not have.
 */
export function updateFinding(
  db: DatabaseSync,
  argusHome: string,
  id: number,
  patch: FindingPatch,
  opts: { actor: 'agent' | 'human'; onUpdated?: (row: FindingRow) => void }
): UpdateResult {
  const cur = db
    .prepare(
      `SELECT f.*, s.mode AS mode, c.slug AS slug FROM ${FINDINGS_WITH_MODE}
         JOIN cases c ON c.id = f.case_id WHERE f.id = ?`
    )
    .get(id) as (Raw & { slug: string }) | undefined
  if (!cur) return { ok: false, reason: 'unknown' }
  const has = (k: keyof FindingPatch): boolean => patch[k] !== undefined
  const text = (patch.appendMarkdown ?? '').trim()
  if (!has('status') && !has('role') && !has('causedBy') && !text)
    return { ok: false, reason: 'empty' }
  if (has('status') && !isFindingStatus(patch.status))
    throw new Error(`Invalid status: ${JSON.stringify(patch.status)}`)
  if (has('role') && patch.role !== null && !isFindingRole(patch.role))
    throw new Error(`Invalid role: ${JSON.stringify(patch.role)}`)
  // The chain is an investigation concept: a review-mode (PR) finding takes evidence appends
  // only, whoever the actor. Checked before every other rule so nothing below can write it.
  if ((cur.mode ?? DEFAULT_MODE) === 'review' && (has('status') || has('role') || has('causedBy')))
    return { ok: false, reason: 'review-mode' }
  if (opts.actor === 'agent') {
    // A human's accept is not the agent's to overturn (same rule as retraction): the claim
    // and the role are settled; evidence and a cause may still be added.
    if (cur.review_state === 'accepted' && (has('status') || has('role')))
      return { ok: false, reason: 'accepted-locked' }
    // The RCA report fixed this role; the agent may argue in chat, the human may override.
    if (has('role') && cur.role_source === 'rca' && isFindingRole(cur.role))
      return { ok: false, reason: 'rca-frozen' }
  }
  if (has('causedBy') && patch.causedBy !== null) {
    const target = patch.causedBy as number
    if (target === id) return { ok: false, reason: 'self-cause' }
    const t = db
      .prepare(`SELECT id, caused_by FROM findings WHERE id = ? AND case_id = ?`)
      .get(target, cur.case_id) as { id: number; caused_by: number | null } | undefined
    if (!t) return { ok: false, reason: 'bad-cause' }
    // Walk toward the root from the target: reaching `id` would close a loop. `seen` stops a
    // walk through a loop that is already there (it cannot be written here, but a hand-edited
    // DB must not hang the writer).
    const parentOf = db.prepare(`SELECT caused_by FROM findings WHERE id = ?`)
    const seen = new Set<number>([t.id])
    let p = t.caused_by
    while (p !== null) {
      if (p === id) return { ok: false, reason: 'cycle' }
      if (seen.has(p)) break
      seen.add(p)
      p = (parentOf.get(p) as { caused_by: number | null } | undefined)?.caused_by ?? null
    }
  }
  const nextRole = has('role') ? patch.role : isFindingRole(cur.role) ? cur.role : null
  const nextStatus = has('status')
    ? patch.status
    : isFindingStatus(cur.status)
      ? cur.status
      : 'confirmed'
  // A transition check: a finding that already IS the confirmed root cause may take evidence
  // or a cause without being refused because of its own (or a resurrected sibling's) standing.
  const alreadyConfirmedRoot =
    cur.role === 'root-cause' && (cur.status === null || cur.status === 'confirmed')
  if (nextRole === 'root-cause' && nextStatus === 'confirmed' && !alreadyConfirmedRoot) {
    const existing = confirmedRootCauseOf(db, cur.case_id, id)
    if (existing !== null) return { ok: false, reason: 'second-root', existingRoot: existing }
  }
  const sets: string[] = []
  const vals: (string | number | null)[] = []
  if (has('status')) {
    sets.push('status = ?')
    vals.push(patch.status as string)
  }
  if (has('role')) {
    sets.push('role = ?', 'role_source = ?')
    vals.push(patch.role ?? null, patch.role === null ? null : opts.actor)
  }
  if (has('causedBy')) {
    sets.push('caused_by = ?')
    vals.push(patch.causedBy ?? null)
  }
  if (sets.length > 0)
    db.prepare(`UPDATE findings SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  const readRow = (): FindingRow =>
    toRow(
      db
        .prepare(`SELECT f.*, s.mode AS mode FROM ${FINDINGS_WITH_MODE} WHERE f.id = ?`)
        .get(id) as unknown as Raw
    )
  const notify = (row: FindingRow): void => {
    try {
      opts.onUpdated?.(row)
    } catch (err) {
      console.error('[findings] onUpdated failed', err)
    }
  }
  if (text) {
    // The row has already changed; a failing body write must not hide that from the hook.
    try {
      const mdPath = path.join(caseDir(argusHome, cur.slug), 'findings.md')
      let md: string
      try {
        md = fs.readFileSync(mdPath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        md = `# Findings — ${cur.slug}\n`
      }
      fs.writeFileSync(mdPath, appendToFindingBody(md, id, text, cur.summary))
    } catch (err) {
      notify(readRow())
      throw err
    }
  }
  const row = readRow()
  notify(row)
  return { ok: true, row }
}

export type SupersedeRefusal = 'unknown' | 'accepted' | 'already-superseded'

/** The retraction reason a superseded finding carries. One string, read back by the dossier. */
export const SUPERSEDED_REASON = (newId: number): string => `superseded by #${newId}`

/** Pre-check for `append_finding(supersedes)`: run BEFORE the new row is inserted so a refused
 *  call leaves no row and no findings.md block. Cross-case and missing are the same answer. */
export function canSupersede(
  db: DatabaseSync,
  caseId: number,
  oldId: number
): { ok: true } | { ok: false; reason: SupersedeRefusal } {
  const cur = db
    .prepare(`SELECT review_state, superseded_by FROM findings WHERE id = ? AND case_id = ?`)
    .get(oldId, caseId) as { review_state: string; superseded_by: number | null } | undefined
  if (!cur) return { ok: false, reason: 'unknown' }
  if (cur.review_state === 'accepted') return { ok: false, reason: 'accepted' }
  if (cur.superseded_by !== null) return { ok: false, reason: 'already-superseded' }
  return { ok: true }
}

/**
 * `append_finding(supersedes: old)` after the new row exists (spec §5.2): retract the old
 * finding with `SUPERSEDED_REASON` (actor agent — retractFinding's rules apply, so a human's
 * rejection is kept and `retracted` is false), link `old.superseded_by = new`, and move the old
 * finding's children to the new one. One transaction. The retraction comes first so a
 * superseded finding is always also rejected and a later edge-nulling cannot revive it.
 */
export function supersedeFinding(
  db: DatabaseSync,
  oldId: number,
  newId: number,
  opts: {
    onOverride?: (row: AttributionRow) => void
    onRetracted?: (row: FindingRow) => void
  } = {}
): { ok: true; row: FindingRow; retracted: boolean } | { ok: false; reason: SupersedeRefusal } {
  // The closed refusal union has no 'self' member, so a self-supersede reuses 'unknown'.
  if (oldId === newId) return { ok: false, reason: 'unknown' }
  const fresh = db.prepare(`SELECT case_id, caused_by FROM findings WHERE id = ?`).get(newId) as
    { case_id: number; caused_by: number | null } | undefined
  if (!fresh) return { ok: false, reason: 'unknown' }
  const pre = canSupersede(db, fresh.case_id, oldId)
  if (!pre.ok) return pre
  const readRow = (id: number): FindingRow =>
    toRow(
      db
        .prepare(`SELECT f.*, s.mode AS mode FROM ${FINDINGS_WITH_MODE} WHERE f.id = ?`)
        .get(id) as unknown as Raw
    )
  db.exec('BEGIN')
  let retracted = false
  // The callbacks are collected inside the transaction and fired after COMMIT, with the row
  // re-read, so a listener sees the final state (superseded_by set) and a rolled-back
  // supersede never notifies anyone.
  let overridden: AttributionRow | null = null
  let fireRetracted = false
  try {
    const r = retractFinding(db, oldId, SUPERSEDED_REASON(newId), {
      actor: 'agent',
      onOverride: (row) => {
        overridden = row
      },
      onRetracted: () => {
        fireRetracted = true
      }
    })
    if (!r.ok) throw new Error(`retract ${oldId}: ${r.reason}`)
    retracted = r.changed
    db.prepare(`UPDATE findings SET superseded_by = ? WHERE id = ?`).run(newId, oldId)
    // The replacement takes the old finding's place in the chain. If the new finding is itself
    // caused by the old one or by anything downstream of it, re-parenting the old finding's
    // children onto it would close a loop (new -> old's child -> new, or new -> new), so first
    // hoist it to the old finding's own cause. `seen` bounds a walk through a pre-existing loop.
    const oldParent = (
      db.prepare(`SELECT caused_by FROM findings WHERE id = ?`).get(oldId) as {
        caused_by: number | null
      }
    ).caused_by
    const childrenOf = db.prepare(`SELECT id FROM findings WHERE caused_by = ? AND case_id = ?`)
    const downstream = new Set<number>([oldId])
    const queue = [oldId]
    while (queue.length) {
      const next = queue.shift() as number
      for (const c of childrenOf.all(next, fresh.case_id) as { id: number }[]) {
        if (downstream.has(c.id)) continue
        downstream.add(c.id)
        queue.push(c.id)
      }
    }
    if (fresh.caused_by !== null && downstream.has(fresh.caused_by))
      db.prepare(`UPDATE findings SET caused_by = ? WHERE id = ?`).run(oldParent, newId)
    db.prepare(
      `UPDATE findings SET caused_by = ? WHERE caused_by = ? AND case_id = ? AND id <> ?`
    ).run(newId, oldId, fresh.case_id, newId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  const row = readRow(oldId)
  if (overridden) {
    try {
      opts.onOverride?.(overridden)
    } catch (err) {
      console.error('[findings] onOverride failed', err)
    }
  }
  if (fireRetracted) {
    try {
      opts.onRetracted?.(row)
    } catch (err) {
      console.error('[findings] onRetracted failed', err)
    }
  }
  return { ok: true, row, retracted }
}

/** findings.md minus the marker segments for `ids` — mode-scoped clear must leave the other
 *  mode's bodies intact. Everything before the first `<!-- finding:N -->` marker (the seeded
 *  header, any pre-marker prose) is always kept. */
export function removeFindingBodies(md: string, ids: ReadonlySet<number>): string {
  const parts = md.split(FINDING_MARKER_SPLIT)
  let out = parts[0]
  for (let i = 1; i < parts.length; i += 2) {
    if (ids.has(Number(parts[i]))) continue
    out += `<!-- finding:${parts[i]} -->${parts[i + 1] ?? ''}`
  }
  return out
}

/**
 * Clear findings per case: with no `mode`, delete every row and reset findings.md to the seeded
 * header createCase writes. With a `mode`, delete only findings whose session-derived mode
 * matches (same COALESCE rule as toRow: session-less rows are investigation) and strip only
 * their findings.md sections. Order: DB → audit → filesystem.
 */
export function clearFindings(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  mode?: ModeId
): { cleared: number } {
  const kase = getCase(db, caseSlug)
  if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
  const mdPath = path.join(caseDir(argusHome, caseSlug), 'findings.md')
  if (mode === undefined) {
    const res = db.prepare(`DELETE FROM findings WHERE case_id = ?`).run(kase.id)
    const cleared = Number(res.changes)
    appendDeletionAudit(argusHome, 'findings.clear', caseSlug, { cleared })
    fs.writeFileSync(mdPath, `# Findings — ${caseSlug}\n`)
    return { cleared }
  }
  const ids = (
    db
      .prepare(
        `SELECT f.id FROM ${FINDINGS_WITH_MODE}
         WHERE f.case_id = ? AND COALESCE(s.mode, ?) = ?`
      )
      .all(kase.id, DEFAULT_MODE, mode) as { id: number }[]
  ).map((r) => r.id)
  if (ids.length > 0) {
    const marks = ids.map(() => '?').join(', ')
    db.prepare(`DELETE FROM findings WHERE id IN (${marks})`).run(...ids)
    // Spec §5.6: a surviving finding of the other mode may not point into the cleared set.
    // (The no-mode branch above deletes every row of the case; no edge survives it.)
    db.prepare(`UPDATE findings SET caused_by = NULL WHERE caused_by IN (${marks})`).run(...ids)
    db.prepare(`UPDATE findings SET superseded_by = NULL WHERE superseded_by IN (${marks})`).run(
      ...ids
    )
  }
  appendDeletionAudit(argusHome, 'findings.clear', caseSlug, { cleared: ids.length, mode })
  if (ids.length > 0) {
    try {
      fs.writeFileSync(mdPath, removeFindingBodies(fs.readFileSync(mdPath, 'utf8'), new Set(ids)))
    } catch (err) {
      // Only a MISSING findings.md is fine to skip (nothing to strip, and a full-file reset
      // would be wrong here). Any other failure means DB and file are now out of sync — say so.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return { cleared: ids.length }
}

/** Order: findings.md splice FIRST, then row delete, then audit. A crash between the
 *  steps leaves a body-less row (visible, re-deletable) — never an orphaned md block. */
export function deleteFinding(db: DatabaseSync, argusHome: string, id: number): { deleted: true } {
  const row = db
    .prepare(
      `SELECT f.*, c.slug AS slug FROM findings f JOIN cases c ON c.id = f.case_id WHERE f.id = ?`
    )
    .get(id) as (Raw & { slug: string }) | undefined
  if (!row) throw new Error(`Unknown finding: ${id}`)
  const mdPath = path.join(caseDir(argusHome, row.slug), 'findings.md')
  try {
    fs.writeFileSync(mdPath, removeFindingBodies(fs.readFileSync(mdPath, 'utf8'), new Set([id])))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  // Spec §5.6: nothing may point at a finding that no longer exists. Children stay, unattached.
  db.prepare(`UPDATE findings SET caused_by = NULL WHERE caused_by = ?`).run(id)
  db.prepare(`UPDATE findings SET superseded_by = NULL WHERE superseded_by = ?`).run(id)
  db.prepare(`DELETE FROM findings WHERE id = ?`).run(id)
  appendDeletionAudit(argusHome, 'finding.delete', row.slug, { id, summary: row.summary })
  return { deleted: true }
}

/**
 * Record the outcome of a write action on a finding. Only the supplied keys are written, so
 * posting a comment never clears a previous push and vice versa. Silently no-ops on an empty
 * patch rather than emitting `SET WHERE id = ?` with no assignments.
 */
export function recordFindingWrite(
  db: DatabaseSync,
  id: number,
  patch: { commentUrl?: string; pushedSha?: string }
): void {
  const sets: string[] = []
  const vals: string[] = []
  if (patch.commentUrl !== undefined) {
    sets.push('comment_url = ?')
    vals.push(patch.commentUrl)
  }
  if (patch.pushedSha !== undefined) {
    sets.push('pushed_sha = ?')
    vals.push(patch.pushedSha)
  }
  if (sets.length === 0) return
  db.prepare(`UPDATE findings SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}

/** The RCA report's writer of findings.role (spec 2026-10-26 §5.1: the other two are
 *  updateFinding's actors). Stamps role_source = 'rca'. One transaction; throws atomically: a rejected
 *  call (invalid role, duplicate root-cause, a finding from another case) leaves every row's
 *  role exactly as it was before the call. Findings on the case that are absent from
 *  `assignments` are cleared to null — this is a full replace, not a merge. */
export function applyReportRoles(
  db: DatabaseSync,
  caseId: number,
  assignments: RoleAssignment[]
): void {
  const roots = assignments.filter((a) => a.role === 'root-cause')
  if (roots.length > 1) throw new Error(`at most one root-cause, got ${roots.length}`)
  for (const a of assignments)
    if (a.role !== null && !isFindingRole(a.role))
      throw new Error(`Invalid role: ${JSON.stringify(a.role)}`)
  db.exec('BEGIN')
  try {
    const own = new Set(
      (db.prepare(`SELECT id FROM findings WHERE case_id = ?`).all(caseId) as { id: number }[]).map(
        (r) => r.id
      )
    )
    for (const a of assignments)
      if (!own.has(a.findingId))
        throw new Error(`finding ${a.findingId} does not belong to case ${caseId}`)
    db.prepare(`UPDATE findings SET role = NULL, role_source = NULL WHERE case_id = ?`).run(caseId)
    for (const a of assignments)
      db.prepare(`UPDATE findings SET role = ?, role_source = ? WHERE id = ?`).run(
        a.role,
        a.role === null ? null : 'rca',
        a.findingId
      )
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
