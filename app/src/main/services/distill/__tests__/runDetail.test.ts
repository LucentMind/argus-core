import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { readRunDetail } from '../runDetail'

let db: DatabaseSync
beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
})

/** Inserts a distill_jobs row and returns its id. */
function insertJob(over: Record<string, string | number | null> = {}): number {
  const cols = {
    case_slug: 'c1',
    state: 'done',
    input_snapshot: '{"caseMeta":{"slug":"c1"}}',
    raw_output: '```json\n{}\n```',
    item_count: 0,
    created_at: '2026-08-19T00:00:00.000Z',
    stages_json: null as string | null,
    dropped_json: null as string | null,
    trajectory_json: null as string | null,
    ...over
  }
  const names = Object.keys(cols).join(', ')
  const marks = Object.keys(cols)
    .map(() => '?')
    .join(', ')
  const res = db
    .prepare(`INSERT INTO distill_jobs (${names}) VALUES (${marks})`)
    .run(...Object.values(cols))
  return Number(res.lastInsertRowid)
}

describe('readRunDetail', () => {
  it('returns null for an unknown job id', () => {
    expect(readRunDetail(db, 9999)).toBeNull()
  })

  it('parses a full v3 row into stages, drops and trajectory', () => {
    const id = insertJob({
      stages_json: JSON.stringify({
        dossier: { promptHash: 'h1', promptChars: 10, rawOutput: 'DOSSIER RAW' },
        candidates: { promptHash: 'h2', promptChars: 20, rawOutput: '[]', error: 'boom' }
      }),
      dropped_json: JSON.stringify([
        { type: 'skill-new', target: 'foo', title: 'Foo', reason: 'duplicate' }
      ]),
      trajectory_json: JSON.stringify([{ tool: 'read_session' }])
    })
    const d = readRunDetail(db, id)!
    expect(d.job.id).toBe(id)
    expect(d.stages!.dossier!.rawOutput).toBe('DOSSIER RAW')
    expect(d.stages!.candidates!.error).toBe('boom')
    expect(d.dropped).toEqual([
      { type: 'skill-new', target: 'foo', title: 'Foo', reason: 'duplicate' }
    ])
    expect(d.trajectory).toHaveLength(1)
    expect(d.inputSnapshotChars).toBe('{"caseMeta":{"slug":"c1"}}'.length)
  })

  it('yields stages null and dropped [] for a v2 row that recorded neither', () => {
    const d = readRunDetail(db, insertJob())!
    expect(d.stages).toBeNull()
    expect(d.dropped).toEqual([])
    expect(d.trajectory).toBeNull()
  })

  it('does not throw on a corrupt stages_json — the panel must open on a broken run', () => {
    const id = insertJob({ stages_json: '{not json', dropped_json: '[[[', trajectory_json: 'x' })
    const d = readRunDetail(db, id)!
    expect(d.stages).toBeNull()
    expect(d.dropped).toEqual([])
    expect(d.trajectory).toBeNull()
    expect(d.rawOutput).toBe('```json\n{}\n```')
  })

  it('treats a well-formed but wrong-shaped dropped_json as empty, not as one bogus row', () => {
    const d = readRunDetail(db, insertJob({ dropped_json: '{"not":"an array"}' }))!
    expect(d.dropped).toEqual([])
  })
})

const DOSSIER_RAW =
  '```json\n{"scope":{"status":"closed","resolution":"solved","settled":true,"note":"n"},"root_cause":{"text":"rc","cites":[{"finding":7}]},"confirmed_fix":null,"rejected_hypotheses":[],"diagnostic_path":[],"durable_facts":[],"user_corrections":[]}\n```'
const CANDS_RAW =
  '```json\n{"candidates":[{"kind":"procedure","type":"skill-edit","target":"diagnose-x","title":"t","outline":"o","evidence":["root_cause"],"related":[],"generalization":"g","routing_rationale":"r","confidence":0.9}]}\n```'
const MAT_RAW =
  '```json\n{"ops":[{"op":"append-section","heading":"## Steps","content":"2. b"}],"basis":"a real basis of twenty+ chars"}\n```'
const SKILL = `---\nname: diagnose-x\ndescription: when X\n---\n# diagnose-x\n\n## Steps\n1. a\n`

describe('readRunDetail.parsed', () => {
  it('parses dossier, summary, candidates and materialize outputs with the pipeline parsers', () => {
    const id = insertJob({
      pipeline: 'v3',
      stages_json: JSON.stringify({
        dossier: { promptHash: 'h', promptChars: 1, rawOutput: DOSSIER_RAW },
        summary: { promptHash: 'h', promptChars: 1, rawOutput: '```json\n{"summary":null}\n```' },
        candidates: { promptHash: 'h', promptChars: 1, rawOutput: CANDS_RAW },
        materialize: [
          {
            promptHash: 'h',
            promptChars: 1,
            rawOutput: MAT_RAW,
            type: 'skill-edit',
            target: 'diagnose-x'
          }
        ]
      })
    })
    const d = readRunDetail(db, id, { currentTarget: () => SKILL })!
    expect(d.pipeline).toBe('v3')
    expect(d.parsed.dossier!.root_cause!.text).toBe('rc')
    expect(d.parsed.summaryPresent).toBe(true)
    expect(d.parsed.summary).toBeNull()
    expect(d.parsed.candidates![0].target).toBe('diagnose-x')
    const m = d.parsed.materialized![0]
    expect(m.output!.ops![0].heading).toBe('## Steps')
    expect(m.diff!.current).toBe(SKILL)
    expect(m.diff!.applied).toContain('2. b')
  })

  it('yields null per stage on unparseable raw output, without failing the others', () => {
    const id = insertJob({
      stages_json: JSON.stringify({
        dossier: { promptHash: 'h', promptChars: 1, rawOutput: 'not json at all' },
        candidates: { promptHash: 'h', promptChars: 1, rawOutput: CANDS_RAW }
      })
    })
    const d = readRunDetail(db, id)!
    expect(d.parsed.dossier).toBeNull()
    expect(d.parsed.candidates).toHaveLength(1)
    expect(d.parsed.summaryPresent).toBe(false)
    expect(d.parsed.materialized).toBeNull()
  })

  it('prunes the dossier against the run input_snapshot — a cite to a finding the snapshot never had is dropped', () => {
    // The model's dossier cites finding #999; the input snapshot it was actually built from only
    // ever had finding #7. The pipeline itself prunes this via pruneUnknownCites before any
    // downstream stage sees the dossier — readRunDetail must apply the same prune, or the card
    // shows a cite chip for a finding that never existed.
    const invented = DOSSIER_RAW.replace('{"finding":7}', '{"finding":999}')
    const id = insertJob({
      pipeline: 'v3',
      input_snapshot: JSON.stringify({
        caseMeta: { slug: 'c1' },
        findings: [{ id: 7, summary: 'f', reviewState: 'accepted', role: 'root-cause', body: '' }],
        evidence: []
      }),
      stages_json: JSON.stringify({
        dossier: { promptHash: 'h', promptChars: 1, rawOutput: invented }
      })
    })
    const d = readRunDetail(db, id)!
    // root_cause loses its only cite and is pruned to null, same as pruneUnknownCites' own
    // semantics (see v3/dossier.ts and dossier.test.ts) — an item with zero surviving cites is
    // dropped, not left with an empty cites array.
    expect(d.parsed.dossier!.root_cause).toBeNull()
  })

  it('keeps the dossier un-pruned when input_snapshot does not parse as JSON', () => {
    const id = insertJob({
      pipeline: 'v3',
      input_snapshot: 'not json',
      stages_json: JSON.stringify({
        dossier: { promptHash: 'h', promptChars: 1, rawOutput: DOSSIER_RAW }
      })
    })
    const d = readRunDetail(db, id)!
    expect(d.parsed.dossier!.root_cause!.text).toBe('rc')
  })

  it('a v2 row has no parsed stages and pipeline v2', () => {
    const d = readRunDetail(db, insertJob())!
    expect(d.pipeline).toBe('v2')
    expect(d.parsed).toEqual({
      dossier: null,
      summaryPresent: false,
      summary: null,
      candidates: null,
      materialized: null
    })
  })

  it('diff is null when the target no longer exists or the ops do not apply', () => {
    const id = insertJob({
      stages_json: JSON.stringify({
        materialize: [
          {
            promptHash: 'h',
            promptChars: 1,
            rawOutput: MAT_RAW,
            type: 'skill-edit',
            target: 'gone'
          }
        ]
      })
    })
    expect(
      readRunDetail(db, id, { currentTarget: () => null })!.parsed.materialized![0].diff
    ).toBeNull()
    expect(
      readRunDetail(db, id, { currentTarget: () => '# no such heading\n' })!.parsed.materialized![0]
        .diff
    ).toBeNull()
  })
})
