import type { DatabaseSync } from 'node:sqlite'
import type { DistillRunDetail } from '../../../shared/distill'
import type { PipelineStages, PreStageDrop } from '../../../shared/distillV3'
import { toRow, type JobDbRow } from './queue'

// `JobDbRow` and `toRow` are reused from queue.ts rather than redeclared here. A second copy of
// the column→field mapping is one fact in two places: adding a field to `DistillJobRow` would
// need both updated, and the compiler cannot see the omission. Both must be exported from
// queue.ts as part of this task (change `interface JobDbRow` → `export interface JobDbRow` and
// `function toRow` → `export function toRow`); nothing else about them changes.

/** JSON.parse that never throws. Returns null on malformed input rather than propagating —
 *  see DistillRunDetail's doc comment for why a corrupt column must stay openable. */
function parseOr<T>(json: string | null): T | null {
  if (json === null) return null
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

export function readRunDetail(db: DatabaseSync, jobId: number): DistillRunDetail | null {
  // SELECT * because `toRow` needs every column `JobDbRow` declares, and the detail fields
  // (input_snapshot, raw_output, *_json) are on the same row.
  const r = db.prepare(`SELECT * FROM distill_jobs WHERE id = ?`).get(jobId) as JobDbRow | undefined
  if (!r) return null
  // Array-ness is checked, not assumed: a well-formed object in an array-typed column would
  // otherwise reach the renderer and be `.map`ped, throwing inside the panel's render.
  const dropped = parseOr<PreStageDrop[]>(r.dropped_json)
  const trajectory = parseOr<unknown[]>(r.trajectory_json)
  return {
    job: toRow(r),
    stages: parseOr<PipelineStages>(r.stages_json),
    dropped: Array.isArray(dropped) ? dropped : [],
    trajectory: Array.isArray(trajectory) ? trajectory : null,
    rawOutput: r.raw_output,
    inputSnapshotChars: r.input_snapshot.length
  }
}
