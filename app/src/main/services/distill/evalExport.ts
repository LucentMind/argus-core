import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { proposalsDir, proposalsArchiveDir } from '../paths'
import { fmBlock, fmField } from '../../../shared/frontmatter'
import { ACCEPTED_CONTENT_DELIMITER } from '../../../shared/proposals'
import type { CaseDistillInput } from '../../../shared/distill'
import type { PipelineStages } from '../../../shared/distillV3'
import type {
  DistillEvalBundleLine,
  DistillEvalExportResult,
  DistillEvalItem
} from '../../../shared/distillEval'

interface JobRow {
  id: number
  case_slug: string
  state: string
  input_snapshot: string
  raw_output: string | null
  error: string | null
  prompt_hash: string | null
  created_at: string
  stages_json: string | null
}

/** Frontmatter + body of every .md in dir, keyed job-id → entries; files without a job stamp
 *  are skipped. */
function scanJobStamped(dir: string): Map<string, { fm: string; body: string }[]> {
  const out = new Map<string, { fm: string; body: string }[]>()
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue
    const block = fmBlock(fs.readFileSync(path.join(dir, ent.name), 'utf8'))
    if (!block) continue
    const job = fmField(block.fm, 'job')
    if (!job) continue
    out.set(job, [...(out.get(job) ?? []), { fm: block.fm, body: block.body }])
  }
  return out
}

/**
 * The human-edited accept text, when present. `archive()` appends the delimiter + accepted text
 * verbatim after the draft body — it never sanitizes the draft, so a draft that itself contains
 * the literal delimiter text (adversarial or just coincidental) would make `.split(...)[1]` grab
 * the wrong half. The delimiter `archive()` appends is always the LAST occurrence in the file
 * (nothing is ever written after it), so `lastIndexOf` is the only split that is correct
 * regardless of what the draft body contains.
 */
function editedContentFrom(fm: string, body: string): string | undefined {
  if (fmField(fm, 'edited') !== 'true') return undefined
  const i = body.lastIndexOf(ACCEPTED_CONTENT_DELIMITER)
  if (i === -1) return undefined
  return body.slice(i + ACCEPTED_CONTENT_DELIMITER.length)
}

export function buildEvalBundle(
  db: DatabaseSync,
  argusHome: string,
  argusVersion: string,
  now: () => Date = () => new Date()
): { lines: DistillEvalBundleLine[]; skipped: DistillEvalExportResult['skipped'] } {
  // Latest job per case only: re-distills supersede (delete un-archived) earlier jobs'
  // pending proposals, so earlier jobs' outcome sets are structurally incomplete. A cancelled
  // job is excluded from the MAX(id) pool: it never reaches stage() (see DistillQueue.cancel /
  // runJob's aborted-path guards), so it never ran the supersede step above — the case's earlier
  // `done` job's archived outcome set is still structurally complete and must not be shadowed by
  // a cancelled re-distill becoming the "latest" row and getting skipped as 'not finished'.
  // The eval bundle is a case's distillation history — a non-case kind (e.g. 'reject-digest')
  // sharing this table must neither shadow a case job in the MAX(id) pool nor be exported
  // itself.
  const rows = db
    .prepare(
      `SELECT * FROM distill_jobs
       WHERE id IN (
         SELECT MAX(id) FROM distill_jobs WHERE state <> 'cancelled' AND kind='case' GROUP BY case_slug
       )
       ORDER BY id ASC`
    )
    .all() as unknown as JobRow[]
  const pending = scanJobStamped(proposalsDir(argusHome))
  const archived = scanJobStamped(proposalsArchiveDir(argusHome))
  const exportedAt = now().toISOString()

  const lines: DistillEvalBundleLine[] = []
  const skipped: DistillEvalExportResult['skipped'] = []
  for (const r of rows) {
    const skip = (reason: string): void => {
      skipped.push({ jobId: r.id, caseSlug: r.case_slug, reason })
    }
    if (r.state !== 'done' && r.state !== 'failed') {
      skip('not finished')
      continue
    }
    if (r.state === 'failed' && r.raw_output === null) {
      skip('failed without output')
      continue
    }
    if (r.state === 'done' && pending.has(String(r.id))) {
      skip('items pending review')
      continue
    }
    const items: DistillEvalItem[] =
      r.state === 'failed'
        ? []
        : (archived.get(String(r.id)) ?? []).map(({ fm, body }) => {
            const outcome = fmField(fm, 'status') as 'accepted' | 'rejected'
            const rejectReason = fmField(fm, 'reject_reason')
            const rejectNote = fmField(fm, 'reject_note')
            const basis = fmField(fm, 'basis')
            const editedContent = editedContentFrom(fm, body)
            return {
              type: fmField(fm, 'type'),
              target: fmField(fm, 'target'),
              title: fmField(fm, 'title'),
              outcome,
              ...(rejectReason ? { rejectReason } : {}),
              ...(rejectNote ? { rejectNote } : {}),
              ...(basis ? { basis } : {}),
              ...(editedContent !== undefined ? { editedContent } : {})
            }
          })
    lines.push({
      job: {
        id: r.id,
        caseSlug: r.case_slug,
        promptHash: r.prompt_hash,
        createdAt: r.created_at,
        state: r.state,
        inputSnapshot: JSON.parse(r.input_snapshot) as CaseDistillInput,
        rawOutput: r.raw_output ?? '',
        error: r.error,
        ...(r.stages_json ? { stages: JSON.parse(r.stages_json) as PipelineStages } : {})
      },
      items,
      exportedAt,
      argusVersion
    })
  }
  return { lines, skipped }
}

export function exportEvalBundle(
  db: DatabaseSync,
  argusHome: string,
  destPath: string,
  argusVersion: string
): DistillEvalExportResult {
  const { lines, skipped } = buildEvalBundle(db, argusHome, argusVersion)
  fs.writeFileSync(
    destPath,
    lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '')
  )
  return { path: destPath, exported: lines.length, skipped }
}
