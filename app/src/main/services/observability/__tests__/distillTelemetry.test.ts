// app/src/main/services/observability/__tests__/distillTelemetry.test.ts
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  distillJobSeed,
  jobIntents,
  proposalScoreId,
  proposalScoreIntent,
  proposalOutcomeOf,
  scrubError
} from '../distillTelemetry'
import type { JobDbRow } from '../../distill/queue'
import type { PipelineStages } from '../../../../shared/distillV3'
import type { EventIntent, GenerationIntent, TraceRootIntent } from '../intent'

const RAW = {
  dossier: 'RAW-DOSSIER-TEXT-7f3a',
  summary: 'RAW-SUMMARY-TEXT-9c1b',
  candidates: 'RAW-CANDIDATES-TEXT-2e8d',
  attribution: 'RAW-ATTRIBUTION-TEXT-5a6f',
  materialize: 'RAW-MATERIALIZE-TEXT-0b4c'
}

const stages: PipelineStages = {
  dossier: {
    promptHash: 'h-d',
    promptChars: 1200,
    rawOutput: RAW.dossier,
    usage: { inputTokens: 1000, outputTokens: 300, costUsd: 0.2, durationMs: 4000 }
  },
  summary: {
    promptHash: 'h-s',
    promptChars: 800,
    rawOutput: RAW.summary,
    usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.05, durationMs: 1000 }
  },
  candidates: {
    promptHash: 'h-c',
    promptChars: 900,
    rawOutput: RAW.candidates,
    usage: { inputTokens: 600, outputTokens: 200, costUsd: 0.08, durationMs: 2000 },
    flags: ['bad-name']
  },
  attribution: {
    promptHash: 'h-a',
    promptChars: 700,
    rawOutput: RAW.attribution,
    usage: { inputTokens: 400, outputTokens: 80, costUsd: 0.02, durationMs: 1500 }
  },
  materialize: [
    {
      type: 'skill-edit',
      target: 'fx-skill',
      promptHash: 'h-m',
      promptChars: 600,
      rawOutput: RAW.materialize,
      usage: { inputTokens: 300, outputTokens: 150, costUsd: 0.2, durationMs: 3000 }
    }
  ],
  dossierUncitedDropped: { diagnostic_path: 2 },
  attributionUncitedDropped: 1
}

const FINISHED = '2026-10-24T10:00:10.000Z'
const finishedMs = Date.parse(FINISHED)

function row(over: Partial<JobDbRow> = {}): JobDbRow {
  return {
    id: 42,
    case_slug: 'fx-helped',
    state: 'done',
    input_snapshot: JSON.stringify({
      caseDomain: 'FXH',
      caseOutcome: 'solved',
      options: { attribution: true }
    }),
    raw_output: 'ignored',
    error: null,
    item_count: 2,
    created_at: '2026-10-24T09:59:00.000Z',
    finished_at: FINISHED,
    kind: 'case',
    input_tokens: 2800,
    output_tokens: 830,
    cost_usd: 0.55,
    duration_ms: 11500,
    prompt_chars: 4200,
    turn_count: 6,
    tool_call_count: 3,
    trajectory_json: null,
    dropped_json: JSON.stringify([
      { type: 'skill-new', target: 'fx-skill', title: 'dup', reason: 'duplicate', stage: 'veto' },
      { type: 'skill-new', target: 'x', title: 'x', reason: 'bad-name', stage: 'validators' },
      { type: 'reference-edit', target: 'y.md', title: 'y', reason: 'cap', stage: 'staging' }
    ]),
    stages_json: JSON.stringify(stages),
    dry_run: 0,
    pipeline: 'v3',
    prompt_hash: 'h-pipeline',
    ...over
  }
}

const ctx = {
  installId: 'inst-1',
  appVersion: '2.7.0',
  judgeModel: () => 'claude-sonnet-5',
  captureContent: false
}

const byKind = <K extends { kind: string }>(all: { kind: string }[], kind: K['kind']): K[] =>
  all.filter((i) => i.kind === kind) as K[]

describe('jobIntents', () => {
  it('a done v3 case row → one root, one generation per stage, drop/counter events', () => {
    const out = jobIntents(row(), ctx)
    const seed = distillJobSeed(42, FINISHED)
    expect(seed).toBe(`argus-distill-job-42@${FINISHED}`)
    expect(out.every((i) => i.seed === seed)).toBe(true)

    const [root] = byKind<TraceRootIntent>(out, 'trace-root')
    expect(root).toMatchObject({ name: 'distill fx-helped', caseSlug: 'fx-helped' })
    expect(root.metadata).toMatchObject({
      jobId: 42,
      kind: 'case',
      pipeline: 'v3',
      state: 'done',
      dryRun: false,
      promptHash: 'h-pipeline',
      itemCount: 2,
      costUsd: 0.55,
      durationMs: 11500,
      turnCount: 6,
      toolCallCount: 3,
      promptChars: 4200,
      installId: 'inst-1',
      appVersion: '2.7.0',
      caseDomain: 'FXH',
      caseOutcome: 'solved',
      createdAt: '2026-10-24T09:59:00.000Z',
      finishedAt: FINISHED
    })
    expect(root.metadata.error).toBeUndefined()
    // per-stage facts ride on the root (GenerationIntent has no metadata)
    expect(root.metadata.stages).toEqual({
      dossier: { promptHash: 'h-d', promptChars: 1200 },
      summary: { promptHash: 'h-s', promptChars: 800 },
      candidates: { promptHash: 'h-c', promptChars: 900, flags: ['bad-name'] },
      attribution: { promptHash: 'h-a', promptChars: 700 },
      'materialize skill-edit fx-skill': { promptHash: 'h-m', promptChars: 600 }
    })

    const gens = byKind<GenerationIntent>(out, 'generation')
    expect(gens.map((g) => g.name)).toEqual([
      'stage dossier',
      'stage summary',
      'stage candidates',
      'stage attribution',
      'stage materialize skill-edit fx-skill'
    ])
    expect(gens.every((g) => g.model === 'claude-sonnet-5')).toBe(true)
    expect(gens[0]).toMatchObject({ usage: { input: 1000, output: 300 }, costUsd: 0.2 })
    expect(gens[0].output).toBeUndefined() // captureContent off
    expect(gens[0].input).toBeUndefined()

    // timing: walk back from finished_at — materialize (3000) last; the parallel group ends
    // before it and its members share one END; dossier ends when the longest parallel member starts
    const m = gens[4]
    expect(m.endTime).toBe(finishedMs)
    expect(m.startTime).toBe(finishedMs - 3000)
    const parEnd = finishedMs - 3000
    for (const g of gens.slice(1, 4)) expect(g.endTime).toBe(parEnd)
    expect(gens[2].startTime).toBe(parEnd - 2000) // candidates, the longest parallel stage
    expect(gens[0].endTime).toBe(parEnd - 2000)
    expect(gens[0].startTime).toBe(parEnd - 2000 - 4000)

    const events = byKind<EventIntent>(out, 'event')
    expect(events.map((e) => e.name).sort()).toEqual(['drops', 'parser drops'])
    expect(events.find((e) => e.name === 'drops')!.metadata).toEqual({
      veto: { duplicate: 1 },
      validators: { 'bad-name': 1 },
      staging: { cap: 1 }
    })
    expect(events.find((e) => e.name === 'parser drops')!.metadata).toEqual({
      dossierUncitedDropped: { diagnostic_path: 2 },
      attributionUncitedDropped: 1
    })
    expect(byKind(out, 'score')).toEqual([])
  })

  it('captureContent=false → no stage raw text anywhere; true → the generations carry it as output', () => {
    const off = JSON.stringify(jobIntents(row(), ctx))
    for (const text of Object.values(RAW)) expect(off).not.toContain(text)
    const on = jobIntents(row(), { ...ctx, captureContent: true })
    const gens = byKind<GenerationIntent>(on, 'generation')
    expect(gens.map((g) => g.output)).toEqual([
      RAW.dossier,
      RAW.summary,
      RAW.candidates,
      RAW.attribution,
      RAW.materialize
    ])
    expect(JSON.stringify(on)).not.toContain('ignored') // raw_output column is never emitted
  })

  it('a failed row → root state=failed with the error, plus a `stage <name> error` event (level ERROR)', () => {
    const failedStages: PipelineStages = {
      dossier: {
        promptHash: 'h-d',
        promptChars: 1200,
        rawOutput: RAW.dossier,
        error: 'parse failed: no json block'
      }
    }
    const out = jobIntents(
      row({
        state: 'failed',
        error: 'dossier: parse failed',
        item_count: null,
        stages_json: JSON.stringify(failedStages),
        dropped_json: null
      }),
      ctx
    )
    const [root] = byKind<TraceRootIntent>(out, 'trace-root')
    expect(root.metadata).toMatchObject({ state: 'failed', error: 'dossier: parse failed' })
    expect((root.metadata.stages as Record<string, unknown>).dossier).toEqual({
      promptHash: 'h-d',
      promptChars: 1200,
      error: 'parse failed: no json block'
    })
    const ev = byKind<EventIntent>(out, 'event').find((e) => e.name === 'stage dossier error')!
    expect(ev).toMatchObject({
      level: 'ERROR',
      metadata: { message: 'parse failed: no json block' }
    })
    // an errored stage still gets a generation (it cost tokens even when it produced nothing usable)
    expect(byKind<GenerationIntent>(out, 'generation').map((g) => g.name)).toEqual([
      'stage dossier'
    ])
  })

  it('attribution-only row → `distill:attribution <slug>`; reject-digest → `distill:reject-digest`; dry run flagged', () => {
    const a = jobIntents(
      row({
        kind: 'attribution',
        stages_json: JSON.stringify({ attribution: stages.attribution }),
        dropped_json: null
      }),
      ctx
    )
    expect(byKind<TraceRootIntent>(a, 'trace-root')[0].name).toBe('distill:attribution fx-helped')
    const d = jobIntents(
      row({
        kind: 'reject-digest',
        case_slug: '__reject-digest__',
        input_snapshot: '{}',
        stages_json: null,
        dropped_json: null
      }),
      ctx
    )
    const [droot] = byKind<TraceRootIntent>(d, 'trace-root')
    expect(droot.name).toBe('distill:reject-digest')
    expect(droot.metadata.caseDomain).toBeUndefined()
    expect(droot.metadata.caseOutcome).toBeUndefined()
    expect(byKind(d, 'generation')).toEqual([])
    const dry = jobIntents(row({ dry_run: 1 }), ctx)
    expect(byKind<TraceRootIntent>(dry, 'trace-root')[0].metadata.dryRun).toBe(true)
  })

  it('attributionSkipped → `attribution skipped` event with the reason', () => {
    const s: PipelineStages = { dossier: stages.dossier, attributionSkipped: 'declined' }
    const out = jobIntents(row({ stages_json: JSON.stringify(s), dropped_json: null }), ctx)
    expect(
      byKind<EventIntent>(out, 'event').find((e) => e.name === 'attribution skipped')!.metadata
    ).toEqual({ reason: 'declined' })
  })

  it('corrupt stages_json → root + counters still emitted, no generations, one `stages unreadable` event', () => {
    const out = jobIntents(row({ stages_json: '{not json' }), ctx)
    expect(byKind(out, 'trace-root')).toHaveLength(1)
    expect(byKind(out, 'generation')).toEqual([])
    expect(
      byKind<EventIntent>(out, 'event')
        .map((e) => e.name)
        .sort()
    ).toEqual(['drops', 'stages unreadable'])
  })

  it('a cancelled row with nothing recorded → root only', () => {
    const out = jobIntents(
      row({
        state: 'cancelled',
        stages_json: null,
        dropped_json: null,
        cost_usd: null,
        duration_ms: null,
        item_count: null
      }),
      ctx
    )
    expect(out).toHaveLength(1)
    expect((out[0] as TraceRootIntent).metadata).toMatchObject({ state: 'cancelled' })
    expect((out[0] as TraceRootIntent).metadata.costUsd).toBeUndefined()
  })

  it("judgeModel throwing → model 'unknown'", () => {
    const out = jobIntents(row(), {
      ...ctx,
      judgeModel: () => {
        throw new Error('no provider')
      }
    })
    expect(byKind<GenerationIntent>(out, 'generation').every((g) => g.model === 'unknown')).toBe(
      true
    )
  })
})

describe('per-attempt seed', () => {
  it('distillJobSeed: id@finished_at; a null finished_at → the plain id seed', () => {
    expect(distillJobSeed(7, '2026-10-24T10:00:10.000Z')).toBe(
      'argus-distill-job-7@2026-10-24T10:00:10.000Z'
    )
    expect(distillJobSeed(7, null)).toBe('argus-distill-job-7')
  })

  it('a retry (same row id, new finished_at) → a different seed, so a new trace', () => {
    const failed = jobIntents(row({ state: 'failed', finished_at: FINISHED }), ctx)
    const retried = jobIntents(row({ finished_at: '2026-10-24T10:05:00.000Z' }), ctx)
    const seedA = byKind<TraceRootIntent>(failed, 'trace-root')[0].seed
    const seedB = byKind<TraceRootIntent>(retried, 'trace-root')[0].seed
    expect(seedA).toBe(`argus-distill-job-42@${FINISHED}`)
    expect(seedB).toBe('argus-distill-job-42@2026-10-24T10:05:00.000Z')
    expect(seedA).not.toBe(seedB)
    expect(retried.every((i) => i.seed === seedB)).toBe(true)
  })

  it('jobIntents on a row with null finished_at → plain seed on every intent', () => {
    const out = jobIntents(row({ finished_at: null }), ctx)
    expect(out.every((i) => i.seed === 'argus-distill-job-42')).toBe(true)
  })
})

describe('jobIntents hardening', () => {
  const PARSE_ERR = `Unexpected token 'S', "RAW-DOSSIER-TEXT-7f3a is" ... is not valid JSON`
  const failedRow = (): JobDbRow =>
    row({
      state: 'failed',
      error: `dossier: ${PARSE_ERR}\nsecond line`,
      item_count: null,
      stages_json: JSON.stringify({
        dossier: { promptHash: 'h-d', promptChars: 1200, rawOutput: RAW.dossier, error: PARSE_ERR }
      } satisfies PipelineStages),
      dropped_json: null
    })

  it('captureContent=false → error strings are cut at the first quote and first-line only', () => {
    const out = jobIntents(failedRow(), ctx)
    expect(JSON.stringify(out)).not.toContain('RAW-DOSSIER-TEXT-7f3a')
    expect(JSON.stringify(out)).not.toContain('second line')
    const [root] = byKind<TraceRootIntent>(out, 'trace-root')
    expect((root.metadata.stages as Record<string, { error: string }>).dossier.error).toBe(
      'Unexpected token …'
    )
    expect(root.metadata.error).toBe('dossier: Unexpected token …')
    const ev = byKind<EventIntent>(out, 'event').find((e) => e.name === 'stage dossier error')!
    expect(ev.metadata).toEqual({ message: 'Unexpected token …' })
  })

  it('captureContent=true → error strings are STILL cut at the first quote (no adapter strips metadata)', () => {
    const out = jobIntents(failedRow(), { ...ctx, captureContent: true })
    const [root] = byKind<TraceRootIntent>(out, 'trace-root')
    expect((root.metadata.stages as Record<string, { error: string }>).dossier.error).toBe(
      'Unexpected token …'
    )
    expect(root.metadata.error).toBe('dossier: Unexpected token …')
    const ev = byKind<EventIntent>(out, 'event').find((e) => e.name === 'stage dossier error')!
    expect(ev.metadata).toEqual({ message: 'Unexpected token …' })
    // Only the generation's `output` (the content-capture channel) carries the raw text.
    const nonGen = out.filter((i) => i.kind !== 'generation')
    expect(JSON.stringify(nonGen)).not.toContain('RAW-DOSSIER-TEXT-7f3a')
  })

  it('scrubError: nested / mixed quotes leak nothing after the first quote of any kind', () => {
    const probes: [string, string][] = [
      [`Unexpected token 's', "{"a": secret-cus"... is not valid JSON`, 'secret-cus'],
      [`Unexpected token 'S', "Sure! {"x":1}" is not valid JSON`, 'Sure!'],
      [`Unexpected token 'I', "I think "A"... is not valid JSON`, 'I think'],
      ['Unexpected `LEAK-BT` in output', 'LEAK-BT'],
      [`model said "LEAK-DQ" then 'other'`, 'LEAK-DQ']
    ]
    for (const [msg, secret] of probes) {
      const out = scrubError(msg)
      expect(out).not.toContain(secret)
      expect(out.endsWith('…')).toBe(true)
      expect(out).not.toMatch(/["'`]/)
    }
    expect(scrubError(probes[0][0])).toBe('Unexpected token …')
    expect(scrubError(probes[3][0])).toBe('Unexpected …')
    expect(scrubError(probes[4][0])).toBe('model said …')
  })

  it('scrubError: a quote-free message passes through, first line only, capped at 300', () => {
    expect(scrubError('request timed out after 30000 ms\n    at stack frame')).toBe(
      'request timed out after 30000 ms'
    )
    expect(scrubError('y'.repeat(1000))).toBe('y'.repeat(300))
  })

  it('error strings are capped at 300 chars', () => {
    const out = jobIntents(row({ state: 'failed', error: 'x'.repeat(1000) }), ctx)
    expect((byKind<TraceRootIntent>(out, 'trace-root')[0].metadata.error as string).length).toBe(
      300
    )
  })

  it('materialize that is not an array, or has null/non-object entries → skipped, never throws', () => {
    const good = stages.materialize![0]
    const notArray = jobIntents(
      row({ stages_json: JSON.stringify({ dossier: stages.dossier, materialize: 'oops' }) }),
      ctx
    )
    expect(byKind<GenerationIntent>(notArray, 'generation').map((g) => g.name)).toEqual([
      'stage dossier'
    ])
    const mixed = jobIntents(
      row({
        stages_json: JSON.stringify({ dossier: stages.dossier, materialize: [null, 5, 'x', good] })
      }),
      ctx
    )
    expect(byKind<GenerationIntent>(mixed, 'generation').map((g) => g.name)).toEqual([
      'stage dossier',
      'stage materialize skill-edit fx-skill'
    ])
  })

  it('dropped_json arrays with null/non-object entries → bad entries skipped, never throws', () => {
    const out = jobIntents(
      row({
        dropped_json: JSON.stringify([
          null,
          7,
          'x',
          { type: 'skill-new', target: 'x', title: 'x', reason: 'cap', stage: 'staging' }
        ])
      }),
      ctx
    )
    expect(byKind<EventIntent>(out, 'event').find((e) => e.name === 'drops')!.metadata).toEqual({
      staging: { cap: 1 }
    })
  })

  it('a drop with no stage → bucket `unknown`', () => {
    const out = jobIntents(
      row({
        dropped_json: JSON.stringify([
          { type: 'skill-new', target: 'x', title: 'x', reason: 'cap' }
        ])
      }),
      ctx
    )
    expect(byKind<EventIntent>(out, 'event').find((e) => e.name === 'drops')!.metadata).toEqual({
      unknown: { cap: 1 }
    })
  })

  it('two materialize entries → reverse walk: the LAST ends at finished_at, the previous ends where the last starts', () => {
    const m1 = { ...stages.materialize![0], target: 'a', usage: { durationMs: 3000 } }
    const m2 = { ...stages.materialize![0], target: 'b', usage: { durationMs: 2000 } }
    const out = jobIntents(
      row({ stages_json: JSON.stringify({ materialize: [m1, m2] }), dropped_json: null }),
      ctx
    )
    const gens = byKind<GenerationIntent>(out, 'generation')
    expect(gens.map((g) => g.name)).toEqual([
      'stage materialize skill-edit a',
      'stage materialize skill-edit b'
    ])
    expect(gens[1].endTime).toBe(finishedMs)
    expect(gens[1].startTime).toBe(finishedMs - 2000)
    expect(gens[0].endTime).toBe(finishedMs - 2000)
    expect(gens[0].startTime).toBe(finishedMs - 5000)
  })

  it('finished_at null → generations still have finite numeric times', () => {
    const out = jobIntents(row({ finished_at: null }), ctx)
    const gens = byKind<GenerationIntent>(out, 'generation')
    expect(gens.length).toBeGreaterThan(0)
    for (const g of gens) {
      expect(Number.isFinite(g.startTime)).toBe(true)
      expect(Number.isFinite(g.endTime)).toBe(true)
    }
  })

  it('a stage with no usage → zero-length generation with no usage/costUsd keys', () => {
    const out = jobIntents(
      row({
        stages_json: JSON.stringify({
          dossier: { promptHash: 'h-d', promptChars: 1, rawOutput: RAW.dossier }
        }),
        dropped_json: null
      }),
      ctx
    )
    const [g] = byKind<GenerationIntent>(out, 'generation')
    expect(g.endTime).toBe(g.startTime)
    expect(g).not.toHaveProperty('usage')
    expect(g).not.toHaveProperty('costUsd')
  })
})

describe('proposal scores', () => {
  const base = {
    file: 'fx-helped-skill-edit.md',
    type: 'skill-edit' as const,
    target: 'fx-helped-skill',
    caseSlug: 'fx-helped',
    jobId: 42 as number | null,
    date: '2026-10-24T10:00:11.123Z'
  }
  const c = { installId: 'inst-1', appVersion: '2.7.0' }
  const D1 = '2026-10-24T10:00:11.123Z'
  const D2 = '2026-10-25T08:30:00.456Z'

  it('deterministic id = sha256(installId|file|date)[0:32]', () => {
    expect(proposalScoreId('inst-1', 'a.md', D1)).toBe(
      createHash('sha256').update(`inst-1|a.md|${D1}`).digest('hex').slice(0, 32)
    )
    expect(proposalScoreId('inst-1', 'a.md', D1)).not.toBe(proposalScoreId('inst-2', 'a.md', D1))
  })

  it('same file name, different write date (re-distill after archive) → different ids', () => {
    expect(proposalScoreId('inst-1', 'a.md', D1)).not.toBe(proposalScoreId('inst-1', 'a.md', D2))
    const first = proposalScoreIntent({ ...base, date: D1, outcome: 'accepted' }, 's', c)
    const second = proposalScoreIntent({ ...base, date: D2, outcome: 'accepted' }, 's', c)
    expect(first.id).not.toBe(second.id)
  })

  it('accepted → 1, edited → 0.5, rejected → 0 with reason tag and note as comment', () => {
    const acc = proposalScoreIntent({ ...base, outcome: 'accepted' }, 'argus-distill-job-42', c)
    expect(acc).toEqual({
      kind: 'score',
      seed: 'argus-distill-job-42',
      name: 'proposal.outcome',
      value: 1,
      id: proposalScoreId('inst-1', base.file, base.date),
      metadata: {
        'argus.proposal.type': 'skill-edit',
        'argus.proposal.target': 'fx-helped-skill',
        'argus.proposal.outcome': 'accepted',
        'argus.proposal.edited': false,
        'argus.case.slug': 'fx-helped',
        'argus.job.id': 42,
        'argus.install.id': 'inst-1',
        'argus.app.version': '2.7.0'
      }
    })
    expect(proposalScoreIntent({ ...base, outcome: 'edited' }, 's', c)).toMatchObject({
      value: 0.5,
      metadata: { 'argus.proposal.edited': true }
    })
    const rej = proposalScoreIntent(
      { ...base, outcome: 'rejected', rejectReason: 'overfit', rejectNote: 'only this ticket' },
      's',
      c
    )
    expect(rej).toMatchObject({
      value: 0,
      comment: 'only this ticket',
      metadata: { 'argus.proposal.reject_reason': 'overfit' }
    })
    expect(rej.metadata).not.toHaveProperty('argus.proposal.reject_note')
  })

  it('reject note → only the first non-empty line, trimmed, capped at 200 chars', () => {
    const two = proposalScoreIntent(
      { ...base, outcome: 'rejected', rejectNote: '\n  first line  \nsecond line' },
      's',
      c
    )
    expect(two.comment).toBe('first line')
    const long = proposalScoreIntent(
      { ...base, outcome: 'rejected', rejectNote: 'y'.repeat(500) },
      's',
      c
    )
    expect(long.comment).toBe('y'.repeat(200))
    const blank = proposalScoreIntent({ ...base, outcome: 'rejected', rejectNote: ' \n ' }, 's', c)
    expect(blank).not.toHaveProperty('comment')
  })

  it('human-authored proposal → argus.job.id null (seed chosen by the caller)', () => {
    const s = proposalScoreIntent(
      { ...base, jobId: null, outcome: 'accepted' },
      'argus-session-9',
      c
    )
    expect(s.seed).toBe('argus-session-9')
    expect(s.metadata!['argus.job.id']).toBeNull()
  })

  it('proposalOutcomeOf maps accept/edit/reject', () => {
    expect(proposalOutcomeOf(false, undefined, 'accept')).toBe('accepted')
    expect(proposalOutcomeOf(true, undefined, 'accept')).toBe('edited')
    expect(proposalOutcomeOf(false, { tag: 'wrong' }, 'reject')).toBe('rejected')
  })
})
