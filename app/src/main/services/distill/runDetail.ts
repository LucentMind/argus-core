import type { DatabaseSync } from 'node:sqlite'
import type {
  CaseDistillInput,
  DistillRunDetail,
  CaseDistillSummary
} from '../../../shared/distill'
import type {
  Dossier,
  KnowledgeCandidate,
  MaterializeOutput,
  PipelineStages,
  PreStageDrop,
  ProposalOutType
} from '../../../shared/distillV3'
import { toRow, pipelineOf, type JobDbRow } from './queue'
import { parseDossier, pruneUnknownCites } from './v3/dossier'
import { parseSummary } from './v3/summary'
import { parseCandidates } from './v3/candidates'
import { parseMaterializeOutput } from './v3/materialize'
import { applyPatch } from './v3/patch'

// `JobDbRow` and `toRow` are reused from queue.ts (both exported there) rather than redeclared
// here. A second copy of the column→field mapping would be one fact in two places: adding a
// field to `DistillJobRow` would need both updated, and the compiler cannot see the omission if
// a second copy silently drifted out of sync.

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

export interface RunDetailDeps {
  /** The CURRENT text of a skill (`skill-edit`) or reference (`reference-edit`) by name, or null
   *  when it no longer exists. Used only to render an edit's ops as a diff — the at-run-time text
   *  is not stored, and the UI labels the diff accordingly. */
  currentTarget?: (type: ProposalOutType, name: string) => string | null
}

/** Run a stage parser; a parse failure is a null field, never a thrown IPC. */
function tryParse<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch {
    return null
  }
}

const OUT_TYPES = new Set<string>(['skill-new', 'skill-edit', 'reference-edit'])

/** Prunes a parsed dossier against the run's OWN input snapshot, the same gate
 *  `runCaseDistillPipeline` runs (`pruneUnknownCites`, v3/dossier.ts) before any downstream stage
 *  ever sees the dossier — without this, the card can show a cite chip for a finding/session/
 *  evidence path that never existed in this run's frozen input. `inputSnapshot` is untrusted
 *  (hand-serialized JSON on a row this panel exists to diagnose broken runs from), so both the
 *  parse and the prune are wrapped: an unreadable or wrong-shaped snapshot keeps the un-pruned
 *  dossier rather than throwing the whole detail read. */
function pruneDossierAgainstSnapshot(
  dossier: Dossier | null,
  inputSnapshot: string
): Dossier | null {
  if (!dossier) return null
  try {
    const input = JSON.parse(inputSnapshot) as CaseDistillInput
    return pruneUnknownCites(dossier, input).dossier
  } catch {
    return dossier
  }
}

function parseStages(
  stages: PipelineStages | null,
  deps: RunDetailDeps,
  inputSnapshot: string
): DistillRunDetail['parsed'] {
  const none: DistillRunDetail['parsed'] = {
    dossier: null,
    summaryPresent: false,
    summary: null,
    candidates: null,
    materialized: null
  }
  if (!stages) return none
  const dossier: Dossier | null = stages.dossier
    ? pruneDossierAgainstSnapshot(
        tryParse(() => parseDossier(stages.dossier!.rawOutput).dossier),
        inputSnapshot
      )
    : null
  const summaryPresent = stages.summary !== undefined
  const summary: CaseDistillSummary | null = stages.summary
    ? tryParse(() => parseSummary(stages.summary!.rawOutput))
    : null
  const candidates: KnowledgeCandidate[] | null = stages.candidates
    ? tryParse(() => parseCandidates(stages.candidates!.rawOutput).candidates)
    : null
  const materialized = Array.isArray(stages.materialize)
    ? stages.materialize.map((m) => {
        const type = OUT_TYPES.has(m.type) ? (m.type as ProposalOutType) : null
        const output: MaterializeOutput | null = type
          ? tryParse(() => parseMaterializeOutput(m.rawOutput, type))
          : null
        let diff: { current: string; applied: string } | null = null
        if (type && type !== 'skill-new' && output && deps.currentTarget) {
          const current = deps.currentTarget(type, m.target)
          if (current !== null) {
            const res = output.whole_file
              ? { ok: true as const, text: output.whole_file }
              : applyPatch(current, output.ops ?? [], output.frontmatter)
            if (res.ok) diff = { current, applied: res.text }
          }
        }
        return { type: m.type, target: m.target, output, diff }
      })
    : null
  return { dossier, summaryPresent, summary, candidates, materialized }
}

export function readRunDetail(
  db: DatabaseSync,
  jobId: number,
  deps: RunDetailDeps = {}
): DistillRunDetail | null {
  // SELECT * because `toRow` needs every column `JobDbRow` declares, and the detail fields
  // (input_snapshot, raw_output, *_json) are on the same row.
  const r = db.prepare(`SELECT * FROM distill_jobs WHERE id = ?`).get(jobId) as JobDbRow | undefined
  if (!r) return null
  // Array-ness is checked, not assumed: a well-formed object in an array-typed column would
  // otherwise reach the renderer and be `.map`ped, throwing inside the panel's render.
  const dropped = parseOr<PreStageDrop[]>(r.dropped_json)
  const trajectory = parseOr<unknown[]>(r.trajectory_json)
  const stages = parseOr<PipelineStages>(r.stages_json)
  return {
    job: toRow(r),
    stages,
    dropped: Array.isArray(dropped) ? dropped : [],
    trajectory: Array.isArray(trajectory) ? trajectory : null,
    rawOutput: r.raw_output,
    inputSnapshotChars: r.input_snapshot.length,
    pipeline: pipelineOf({
      pipeline: r.pipeline,
      has_stages: r.stages_json !== null,
      state: r.state
    }),
    parsed: parseStages(stages, deps, r.input_snapshot)
  }
}
