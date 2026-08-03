import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  CaseRcaInput,
  PostResults,
  RcaDraft,
  RcaJobRow,
  RcaJobState,
  RcaStatusPayload,
  RoleAssignment
} from '../../../shared/rca'
import { getCase } from '../caseService'
import { applyReportRoles } from '../findings'
import { artifactsDir } from '../paths'
import { buildCaseRcaPrompt } from './contract'
import { parseRcaOutput, RcaParseError } from './parse'
import { renderExecReport, renderTechReport } from './render'

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
  created_at: string
  finished_at: string | null
}

function toRow(r: JobDbRow): RcaJobRow {
  return {
    id: r.id,
    caseSlug: r.case_slug,
    state: r.state as RcaJobState,
    error: r.error,
    confirmedAt: r.confirmed_at,
    postResults: r.post_results ? (JSON.parse(r.post_results) as PostResults) : null,
    createdAt: r.created_at,
    finishedAt: r.finished_at
  }
}

/** Parses `raw_output` into a draft only for a `done` row; a `done` row whose raw_output
 *  no longer parses (schema drift, hand-edited DB) reports `draft: null` rather than
 *  throwing — status reads must never fail. */
function toPayload(r: JobDbRow): RcaStatusPayload {
  const job = toRow(r)
  let draft: RcaDraft | null = null
  if (job.state === 'done' && r.raw_output) {
    try {
      draft = parseRcaOutput(r.raw_output)
    } catch {
      draft = null
    }
  }
  return { caseSlug: job.caseSlug, job, draft }
}

/** `artifacts/rca-structure.json` if present and parseable, else null. This is the prior
 *  confirmed draft a new `generate()` snapshots into the prompt so the model respects
 *  earlier human role/edit decisions (RCA_CONTRACT rule 7). */
function readPriorDraft(argusHome: string, slug: string): RcaDraft | null {
  try {
    const raw = fs.readFileSync(
      path.join(artifactsDir(argusHome, slug), 'rca-structure.json'),
      'utf8'
    )
    return JSON.parse(raw) as RcaDraft
  } catch {
    return null
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
   *  confirmed job's structure file; throws only on snapshot failure (callers guard it). */
  generate(slug: string): RcaJobRow {
    const prior = readPriorDraft(this.deps.argusHome, slug)
    const snapshot = JSON.stringify(this.deps.assembleInput(slug, prior))
    const res = this.deps.db
      .prepare(
        `INSERT INTO rca_jobs (case_slug, state, input_snapshot, prompt_hash, created_at) VALUES (?, 'queued', ?, ?, ?)`
      )
      .run(slug, snapshot, this.deps.promptHash?.() ?? null, new Date().toISOString())
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
    if (!r) return { caseSlug: slug, job: null, draft: null }
    return toPayload(r)
  }

  /**
   * Freezes a done job's (edited) draft: role assignments first (its own transaction via
   * `applyReportRoles`), then the three artifact files, then `confirmed_at` LAST (spec
   * §5). If the process dies between the files and the flag, the files exist without the
   * flag; re-confirming rewrites them, which is idempotent.
   */
  confirm(slug: string, jobId: number, assignments: RoleAssignment[], edited: RcaDraft): void {
    const job = this.get(jobId)
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
    fs.writeFileSync(path.join(dir, 'rca-exec.md'), renderExecReport(edited, meta))
    fs.writeFileSync(path.join(dir, 'rca-tech.md'), renderTechReport(edited, meta))
    this.deps.db
      .prepare(`UPDATE rca_jobs SET confirmed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), jobId)
    this.emit(slug)
  }

  /** Test helper: resolves once nothing is queued or running. See class docs for race analysis. */
  idle(): Promise<void> {
    if (!this.running && !this.nextQueued()) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private get(id: number): RcaJobRow | null {
    const r = this.deps.db.prepare(`SELECT * FROM rca_jobs WHERE id = ?`).get(id) as
      JobDbRow | undefined
    return r ? toRow(r) : null
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
      const prompt = buildCaseRcaPrompt(input, this.deps.resolvePrompt)
      const raw = await this.deps.run(prompt)
      // Validates; the draft itself is stored only as raw_output — statusFor parses it
      // back out on read.
      parseRcaOutput(raw)
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
