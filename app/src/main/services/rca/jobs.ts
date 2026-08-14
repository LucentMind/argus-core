import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  CaseRcaInput,
  PostResults,
  RcaDraft,
  RcaDroppedSections,
  RcaJobRow,
  RcaJobState,
  RcaStatusPayload,
  RoleAssignment
} from '../../../shared/rca'
import { getCase } from '../caseService'
import { applyReportRoles } from '../findings'
import { artifactsDir } from '../paths'
import { buildCaseRcaPrompt } from './contract'
import { expectedSectionIds, parseRcaOutput, validateRcaDraft, RcaParseError } from './parse'
import { renderExecReport, renderTechReport, templateFromSnapshot, toIdSet } from './render'
import type { AppSettings } from '../../../shared/settings'

export interface RcaJobsDeps {
  db: DatabaseSync
  argusHome: string
  /** Throws → caller sees the throw; nothing is enqueued (guarded by callers). */
  assembleInput: (slug: string, prior: RcaDraft | null) => CaseRcaInput
  run: (prompt: string) => Promise<string>
  resolvePrompt?: (id: string) => string
  /** Version hash of the static RCA prompt parts, stamped at enqueue. Absent in tests. */
  promptHash?: () => string
  broadcast: (payload: RcaStatusPayload) => void
  /** Live settings; read ONLY at generate time to snapshot `rca.template` onto the job. */
  settings: () => AppSettings
}

interface JobDbRow {
  id: number
  case_slug: string
  state: string
  input_snapshot: string
  prompt_hash: string | null
  raw_output: string | null
  error: string | null
  confirmed_at: string | null
  post_results: string | null
  template_snapshot: string | null
  dropped_sections: string | null
  created_at: string
  finished_at: string | null
}

/** A malformed `post_results` cell (schema drift, hand-edited DB) degrades to `null`
 *  rather than throwing — same posture as `toPayload`'s `raw_output` guard below; reads
 *  must never fail on a row a later task (Jira/Confluence posting) hasn't finished
 *  writing yet. */
function parsePostResults(raw: string | null): PostResults | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as PostResults
  } catch {
    return null
  }
}

/** The section ids the user dropped when confirming, or `{}` for a NULL/garbage cell — same
 *  posture as `templateFromSnapshot`: a read must never fail on a row an older build wrote.
 *  Only the two known report keys are carried through, and each is coerced by `toIdSet` at the
 *  render call, so a hand-edited value can never throw out of a status read. */
function droppedFromSnapshot(raw: string | null): RcaDroppedSections {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const v = parsed as RcaDroppedSections
  const out: RcaDroppedSections = {}
  if (Array.isArray(v.exec)) out.exec = [...toIdSet(v.exec)]
  if (Array.isArray(v.tech)) out.tech = [...toIdSet(v.tech)]
  return out
}

function toRow(r: JobDbRow): RcaJobRow {
  return {
    id: r.id,
    caseSlug: r.case_slug,
    state: r.state as RcaJobState,
    error: r.error,
    confirmedAt: r.confirmed_at,
    postResults: parsePostResults(r.post_results),
    createdAt: r.created_at,
    finishedAt: r.finished_at
  }
}

function parseRawOutput(raw: string | null): RcaDraft | null {
  if (!raw) return null
  try {
    return parseRcaOutput(raw)
  } catch {
    return null
  }
}

/** Parses `raw_output` into a draft for a `done` row, EXCEPT when the newest job is
 *  confirmed: a confirmed job's `draft` must reflect the human's edited/frozen structure
 *  (`artifacts/rca-structure.json`), not the model's original raw output — otherwise
 *  reopening the panel after Confirm & freeze would silently show stale, unedited claims
 *  (the confirmed roles/artifacts are already frozen; the review UI must match them). Falls
 *  back to the raw-output parse when the structure file is missing (ENOENT — matches
 *  `readPriorDraft`'s "no prior draft" case) OR unreadable/corrupt; a `done` row whose
 *  raw_output also no longer parses reports `draft: null` rather than throwing — status
 *  reads must never fail. */
function toPayload(r: JobDbRow, argusHome: string): RcaStatusPayload {
  const job = toRow(r)
  let draft: RcaDraft | null = null
  if (job.state === 'done') {
    if (job.confirmedAt) {
      try {
        draft = readPriorDraft(argusHome, job.caseSlug)
      } catch (err) {
        console.error('[rca] failed to read confirmed structure for', job.caseSlug, err)
        draft = null
      }
      if (draft === null) draft = parseRawOutput(r.raw_output)
    } else {
      draft = parseRawOutput(r.raw_output)
    }
  }
  return {
    caseSlug: job.caseSlug,
    job,
    draft,
    template: templateFromSnapshot(r.template_snapshot),
    dropped: droppedFromSnapshot(r.dropped_sections)
  }
}

/**
 * `artifacts/rca-structure.json` — the prior confirmed draft a new `generate()`
 * snapshots into the prompt so the model respects earlier human role/edit decisions
 * (RCA_CONTRACT rule 7). ENOENT (no case has been confirmed yet) is the only case that
 * silently means "no prior draft" → null. Any other read error (permissions, EBUSY, a
 * partially-written file) or a JSON.parse failure on a file that DOES exist is a real
 * error and must NOT collapse to null — doing so would silently regenerate an RCA
 * without the user's confirmed edits, breaking that guarantee. It throws instead,
 * matching `RcaJobsDeps.assembleInput`'s documented "throws → caller sees the throw"
 * posture; `generate()` does not catch it, so callers that guard `generate()` calls
 * (mirroring how distill's `enqueue` snapshot failures are guarded) see the throw too.
 */
function readPriorDraft(argusHome: string, slug: string): RcaDraft | null {
  const file = path.join(artifactsDir(argusHome, slug), 'rca-structure.json')
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    return JSON.parse(raw) as RcaDraft
  } catch (err) {
    throw new Error(
      `prior RCA draft at ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Single in-flight FIFO runner over the `rca_jobs` table. Modeled directly on
 * `distill/queue.ts`'s `DistillQueue` — see that file's class docs for the full race
 * analysis of `idle()`/`kick()`; the same synchronous-read guarantees hold here
 * unchanged (single-threaded Node + synchronous `node:sqlite`, no `await` between a
 * state mutation and the code that reads it back).
 *
 * Differences from `DistillQueue`: no staging step (`runJob` only validates via
 * `parseRcaOutput` — the parsed draft itself is never persisted, only `raw_output`);
 * `statusFor` additionally parses `raw_output` into `draft` for `done` jobs; `generate`
 * snapshots the prior confirmed draft (read from disk) into the input so the model sees
 * earlier human decisions; and `confirm` freezes a done job's draft into roles + report
 * artifacts.
 */
export class RcaJobs {
  private running = false
  private waiters: (() => void)[] = []

  constructor(private deps: RcaJobsDeps) {}

  /**
   * running → failed('app quit mid-run'); returns count of rows flipped. A prior process
   * can also quit between a job's INSERT (state='queued') and its kick() loop ever
   * running — that job survives the UPDATE above untouched, so once recovery is done,
   * resume the loop if anything is still queued.
   */
  recoverOnBoot(): number {
    const res = this.deps.db
      .prepare(
        `UPDATE rca_jobs SET state='failed', error='app quit mid-run', finished_at=? WHERE state='running'`
      )
      .run(new Date().toISOString())
    if (this.nextQueued()) this.kick()
    return Number(res.changes)
  }

  /** Snapshots `assembleInput(slug, prior)` NOW, with `prior` read from the newest
   *  confirmed job's structure file; throws on an unknown slug (checked FIRST, before any
   *  file read — mirrors the `assertSlug`-then-act shape sibling IPC handlers use), on
   *  snapshot failure, OR a non-ENOENT `readPriorDraft` failure (callers guard it — see
   *  `readPriorDraft`'s doc). */
  generate(slug: string): RcaJobRow {
    if (!getCase(this.deps.db, slug)) throw new Error(`Unknown case: ${slug}`)
    const prior = readPriorDraft(this.deps.argusHome, slug)
    const snapshot = JSON.stringify(this.deps.assembleInput(slug, prior))
    const res = this.deps.db
      .prepare(
        `INSERT INTO rca_jobs (case_slug, state, input_snapshot, prompt_hash, template_snapshot, created_at) VALUES (?, 'queued', ?, ?, ?, ?)`
      )
      .run(
        slug,
        snapshot,
        this.deps.promptHash?.() ?? null,
        JSON.stringify(this.deps.settings().rca.template),
        new Date().toISOString()
      )
    const job = this.get(Number(res.lastInsertRowid))!
    this.emit(slug)
    this.kick()
    return job
  }

  /** Latest job (highest id) for slug, with its parsed draft when done. */
  statusFor(slug: string): RcaStatusPayload {
    const r = this.deps.db
      .prepare(`SELECT * FROM rca_jobs WHERE case_slug = ? ORDER BY id DESC LIMIT 1`)
      .get(slug) as JobDbRow | undefined
    if (!r)
      return {
        caseSlug: slug,
        job: null,
        draft: null,
        template: templateFromSnapshot(null),
        dropped: {}
      }
    return toPayload(r, this.deps.argusHome)
  }

  /**
   * Freezes a done job's (edited) draft: `edited` is re-validated against `draftSchema`
   * FIRST — `RcaPanel` already sends a well-formed `RcaDraft`, but the IPC boundary is not
   * trusted (a stale/hand-edited renderer payload must not reach `applyReportRoles` or the
   * filesystem) — then role assignments (its own transaction via `applyReportRoles`), then
   * the three artifact files, then `confirmed_at` LAST (spec §5). If the process dies
   * between the files and the flag, the files exist without the flag; re-confirming
   * rewrites them, which is idempotent.
   */
  confirm(
    slug: string,
    jobId: number,
    assignments: RoleAssignment[],
    edited: RcaDraft,
    dropped?: RcaDroppedSections
  ): void {
    validateRcaDraft(edited)
    const row = this.getRow(jobId)
    const job = row ? toRow(row) : null
    if (!job || job.caseSlug !== slug || job.state !== 'done')
      throw new Error(`rca job ${jobId} is not a done job for ${slug}`)
    const kase = getCase(this.deps.db, slug)
    if (!kase) throw new Error(`Unknown case: ${slug}`)
    applyReportRoles(this.deps.db, kase.id, assignments)
    const dir = artifactsDir(this.deps.argusHome, slug)
    fs.mkdirSync(dir, { recursive: true })
    const meta: CaseRcaInput['caseMeta'] = {
      slug: kase.slug,
      title: kase.title,
      jiraKey: kase.jiraKey,
      resolution: kase.resolution,
      tags: kase.tags,
      createdAt: kase.createdAt
    }
    fs.writeFileSync(path.join(dir, 'rca-structure.json'), JSON.stringify(edited, null, 2))
    // `toIdSet` (the same coercion the `rca:render-preview` handler uses) makes a malformed
    // payload render as "nothing dropped" rather than throwing mid-confirm, after roles have
    // already been written.
    const template = templateFromSnapshot(row!.template_snapshot)
    const execOpts = { template, dropped: toIdSet(dropped?.exec) }
    const techOpts = { template, dropped: toIdSet(dropped?.tech) }
    fs.writeFileSync(path.join(dir, 'rca-exec.md'), renderExecReport(edited, meta, execOpts))
    fs.writeFileSync(path.join(dir, 'rca-tech.md'), renderTechReport(edited, meta, techOpts))
    // Persisted so a later re-render (e.g. "has this report been hand-edited?") can reproduce
    // the confirmed bytes after a window reload. Absent → NULL, i.e. byte-identical to before.
    // `meta` is snapshotted alongside it, in the SAME write as the bytes it produced: `title`
    // and `jiraKey` are both mutable after confirm (most commonly linking Jira, which is
    // required before the report can be posted at all), so a later re-render must replay this
    // exact meta rather than the live case row or an untouched report would falsely read as
    // hand-edited.
    this.deps.db
      .prepare(
        `UPDATE rca_jobs SET confirmed_at = ?, dropped_sections = ?, meta_snapshot = ? WHERE id = ?`
      )
      .run(
        new Date().toISOString(),
        dropped ? JSON.stringify(dropped) : null,
        JSON.stringify(meta),
        jobId
      )
    this.emit(slug)
  }

  /** Test helper: resolves once nothing is queued or running. See class docs for race analysis. */
  idle(): Promise<void> {
    if (!this.running && !this.nextQueued()) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private get(id: number): RcaJobRow | null {
    const r = this.getRow(id)
    return r ? toRow(r) : null
  }

  /** Raw row (including `template_snapshot`), or `undefined` if `id` doesn't exist. */
  private getRow(id: number): JobDbRow | undefined {
    return this.deps.db.prepare(`SELECT * FROM rca_jobs WHERE id = ?`).get(id) as
      JobDbRow | undefined
  }

  private nextQueued(): JobDbRow | undefined {
    return this.deps.db
      .prepare(`SELECT * FROM rca_jobs WHERE state='queued' ORDER BY id ASC LIMIT 1`)
      .get() as JobDbRow | undefined
  }

  /**
   * Invariant: emit() never throws. Broadcasts are advisory UI notifications, never
   * load-bearing — job state persistence and kick-loop progress must not depend on
   * renderer liveness. Any broadcast failure is logged and swallowed so callers
   * (generate/confirm/runJob) keep their own throw contracts intact.
   */
  private emit(slug: string): void {
    try {
      this.deps.broadcast(this.statusFor(slug))
    } catch (err) {
      console.error('[rca] broadcast failed', err)
    }
  }

  private kick(): void {
    if (this.running) return
    this.running = true
    void (async () => {
      try {
        for (;;) {
          const next = this.nextQueued()
          if (!next) break
          await this.runJob(next)
        }
      } finally {
        this.running = false
        for (const w of this.waiters.splice(0)) w()
      }
    })()
  }

  private async runJob(r: JobDbRow): Promise<void> {
    const db = this.deps.db
    db.prepare(`UPDATE rca_jobs SET state='running' WHERE id=?`).run(r.id)
    this.emit(r.case_slug)
    const finish = (fields: string, ...vals: (string | number | null)[]): void => {
      db.prepare(`UPDATE rca_jobs SET ${fields}, finished_at=? WHERE id=?`).run(
        ...vals,
        new Date().toISOString(),
        r.id
      )
      this.emit(r.case_slug)
    }
    try {
      const input = JSON.parse(r.input_snapshot) as CaseRcaInput
      // The job's OWN template, not live settings: a template edited between enqueue and run
      // must not change what this job is asked for, or its output would fail validation
      // against keys the model was never briefed on.
      const template = templateFromSnapshot(r.template_snapshot)
      const prompt = buildCaseRcaPrompt(input, template, this.deps.resolvePrompt)
      const raw = await this.deps.run(prompt)
      // Validates, including that every briefed section came back; the draft itself is stored
      // only as raw_output — statusFor parses it back out on read.
      parseRcaOutput(raw, expectedSectionIds(template))
      finish(`state='done', raw_output=?`, raw)
    } catch (err) {
      if (err instanceof RcaParseError) {
        finish(`state='failed', error=?, raw_output=?`, err.message, err.raw)
      } else {
        finish(`state='failed', error=?`, err instanceof Error ? err.message : String(err))
      }
    }
  }
}
