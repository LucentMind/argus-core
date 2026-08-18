import { describe, it, expect } from 'vitest'
import { runCaseDistillPipeline, MATERIALIZE_CONCURRENCY, type PipelineRunners } from '../pipeline'
import { DistillAgentRunError } from '../../caseDistiller'
import { DISTILL_ALLOWED_TOOLS } from '../../worldTools'
import type { CaseDistillInput } from '../../../../../shared/distill'
import type { HeadlessAgentResult, HeadlessResult } from '../../../agent/driver'

const SKILL = `---\nname: diagnose-x\ndescription: when X\n---\n# diagnose-x\n\n## Steps\n1. a\n`
const INPUT: CaseDistillInput = {
  caseMeta: {
    slug: 'c1',
    title: 'T',
    jiraKey: null,
    status: 'closed',
    resolution: 'solved',
    tags: [],
    createdAt: 'a',
    closedAt: 'b'
  },
  findings: [{ id: 7, summary: 'f', reviewState: 'accepted', role: 'root-cause', body: '' }],
  evidence: [],
  sessionTitles: [],
  skillsIndex: [{ name: 'diagnose-x', description: 'when X', content: SKILL }],
  referencesIndex: [],
  rcaStructure: null,
  alreadyCaptured: { proposals: [] },
  world: { sessions: [] }
}
const DOSSIER =
  '```json\n{"scope":{"status":"closed","resolution":"solved","settled":true,"note":""},"root_cause":{"text":"rc","cites":[{"finding":7}]},"confirmed_fix":null,"rejected_hypotheses":[],"diagnostic_path":[],"durable_facts":[],"user_corrections":[]}\n```'
const SUMMARY =
  '```json\n{"summary":{"signature":"s","symptoms":"y","rootCause":"r","fix":"f","keywords":["k"]}}\n```'
const CANDS =
  '```json\n{"candidates":[{"kind":"procedure","type":"skill-edit","target":"diagnose-x","title":"t","outline":"o","evidence":["root_cause"],"related":[],"generalization":"g","routing_rationale":"r","confidence":0.9},{"kind":"procedure","type":"skill-new","target":"diagnose-x","title":"dup","outline":"o","evidence":["root_cause"],"related":[],"generalization":"g","routing_rationale":"r","confidence":0.5}]}\n```'
const MAT =
  '```json\n{"ops":[{"op":"append-section","heading":"## Steps","content":"2. b"}],"basis":"a real basis of twenty+ chars"}\n```'

const agentOk = (text: string) => async (): Promise<HeadlessAgentResult> => ({
  text,
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5, durationMs: 100 },
  turnCount: 2,
  toolCallCount: 1,
  trajectory: []
})
function oneShotBy(map: (prompt: string) => string): PipelineRunners['oneShot'] {
  return async (prompt): Promise<HeadlessResult> => ({
    text: map(prompt),
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, durationMs: 10 }
  })
}
/** Three distinct edit targets — 'solved' caps kept candidates at 3, the default width. */
const MANY_TARGETS = ['diagnose-x', 'diagnose-y', 'diagnose-z']
const manyInput = (): CaseDistillInput => ({
  ...INPUT,
  skillsIndex: MANY_TARGETS.map((name) => ({
    name,
    description: 'when X',
    content: SKILL.split('diagnose-x').join(name)
  }))
})
const manyCands = (): string =>
  '```json\n' +
  JSON.stringify({
    candidates: MANY_TARGETS.map((t) => ({
      kind: 'procedure',
      type: 'skill-edit',
      target: t,
      title: t,
      outline: 'o',
      evidence: ['root_cause'],
      related: [],
      generalization: 'g',
      routing_rationale: 'r',
      confidence: 0.9
    }))
  }) +
  '\n```'

const route = (p: string): string =>
  p.includes('# Dossier (established') ? CANDS : p.includes('# Candidate') ? MAT : SUMMARY

describe('runCaseDistillPipeline', () => {
  it('runs dossier → 2a‖2b → veto → materialize → output, recording every stage', async () => {
    const seenAgentOpts: unknown[] = []
    const run = await runCaseDistillPipeline(INPUT, {
      agent: async (_p, opts) => {
        seenAgentOpts.push(opts)
        return agentOk(DOSSIER)()
      },
      oneShot: oneShotBy(route)
    })
    // The seam's `allowedTools` IS the driver's canUseTool whitelist (the SDK-level option is
    // pinned to [] inside the driver) — an empty list here would deny every world tool.
    expect((seenAgentOpts[0] as { allowedTools: string[] }).allowedTools).toEqual(
      DISTILL_ALLOWED_TOOLS
    )
    expect(run.output.summary?.signature).toBe('s')
    expect(run.output.proposals).toHaveLength(1)
    expect(run.output.proposals?.[0].content).toContain('1. a\n2. b')
    expect(run.output.proposals?.[0].evidence).toBe('[{"finding":7}]')
    expect(run.preStageDropped).toEqual([
      { type: 'skill-new', target: 'diagnose-x', title: 'dup', reason: 'target-exists' }
    ])
    expect(run.stages?.dossier?.rawOutput).toBe(DOSSIER)
    expect(run.stages?.summary?.promptHash).toMatch(/^[0-9a-f]{12}$/)
    expect(run.stages?.materialize?.[0].target).toBe('diagnose-x')
    // aggregates: dossier 0.5 + summary 0.01 + candidates 0.01 + 1 materialize 0.01
    expect(run.usage?.costUsd).toBeCloseTo(0.53)
    expect(run.usage?.inputTokens).toBe(13)
    expect(run.turnCount).toBe(2)
    expect(run.raw).toContain('```json')
  })

  it('dossier failure throws DistillAgentRunError carrying stages', async () => {
    const err = await runCaseDistillPipeline(INPUT, {
      agent: agentOk('no fence'),
      oneShot: oneShotBy(route)
    }).catch((e) => e)
    expect(err).toBeInstanceOf(DistillAgentRunError)
    expect(err.agentMeta.stages.dossier.rawOutput).toBe('no fence')
    expect(err.agentMeta.stages.dossier.error).toMatch(/fence/)
  })

  it('capHit on the dossier is never parsed', async () => {
    const err = await runCaseDistillPipeline(INPUT, {
      agent: async () => ({ ...(await agentOk(DOSSIER)()), capHit: 'iterations' as const }),
      oneShot: oneShotBy(route)
    }).catch((e) => e)
    expect(err).toBeInstanceOf(DistillAgentRunError)
    expect(err.capHit).toBe('iterations')
  })

  it('summary failure is non-fatal and recorded', async () => {
    const run = await runCaseDistillPipeline(INPUT, {
      agent: agentOk(DOSSIER),
      oneShot: oneShotBy((p) =>
        p.includes('# Dossier\n') && !p.includes('established') ? 'garbage' : route(p)
      )
    })
    expect(run.output.summary).toBeUndefined()
    expect(run.stages?.summary?.error).toBeTruthy()
    expect(run.output.proposals).toHaveLength(1)
  })

  it('candidates failure is fatal and carries dossier + candidates stages', async () => {
    const err = await runCaseDistillPipeline(INPUT, {
      agent: agentOk(DOSSIER),
      oneShot: oneShotBy((p) => (p.includes('established') ? 'garbage' : route(p)))
    }).catch((e) => e)
    expect(err).toBeInstanceOf(DistillAgentRunError)
    expect(err.agentMeta.stages.candidates.error).toBeTruthy()
    expect(err.agentMeta.stages.dossier.rawOutput).toBe(DOSSIER)
  })

  it('a materialize failure drops that candidate only', async () => {
    const run = await runCaseDistillPipeline(INPUT, {
      agent: agentOk(DOSSIER),
      oneShot: oneShotBy((p) => (p.includes('# Candidate') ? 'garbage' : route(p)))
    })
    expect(run.output.proposals).toEqual([])
    expect(run.preStageDropped?.find((d) => d.reason === 'materialize-error')?.target).toBe(
      'diagnose-x'
    )
    expect(run.stages?.materialize?.[0].error).toBeTruthy()
  })

  it('validator drop is recorded with its reason', async () => {
    const bad = MAT.replace('2. b', 'see case c1')
    const run = await runCaseDistillPipeline(INPUT, {
      agent: agentOk(DOSSIER),
      oneShot: oneShotBy((p) => (p.includes('# Candidate') ? bad : route(p)))
    })
    expect(run.output.proposals).toEqual([])
    expect(run.preStageDropped?.map((d) => d.reason)).toContain('case-identifiers')
  })

  it('a validator FLAG keeps the proposal and is recorded on flags, not error', async () => {
    // whole_file is the escape hatch: `broad-edit` becomes a flag, not a drop.
    const rewritten = `---\nname: diagnose-x\ndescription: when X\n---\n# diagnose-x\n\n## Procedure\n1. rewritten step one\n2. rewritten step two\n`
    const whole =
      '```json\n' +
      JSON.stringify({ whole_file: rewritten, basis: 'a real basis of twenty+ chars' }) +
      '\n```'
    const run = await runCaseDistillPipeline(INPUT, {
      agent: agentOk(DOSSIER),
      oneShot: oneShotBy((p) => (p.includes('# Candidate') ? whole : route(p)))
    })
    expect(run.output.proposals).toHaveLength(1)
    expect(run.stages?.materialize?.[0].flags).toContain('broad-edit')
    expect(run.stages?.materialize?.[0].error).toBeUndefined()
  })

  it('an abort mid-stage rejects the run rather than recording a stage error', async () => {
    const ac = new AbortController()
    const err = await runCaseDistillPipeline(
      INPUT,
      {
        agent: agentOk(DOSSIER),
        oneShot: async (p): Promise<HeadlessResult> => {
          if (p.includes('# Dossier (established')) return { text: CANDS }
          ac.abort()
          throw new Error('cancelled')
        }
      },
      undefined,
      ac.signal
    ).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('cancelled')
  })

  it('an abort between materialize calls stops the queue instead of draining it', async () => {
    const ac = new AbortController()
    let calls = 0
    const run = await runCaseDistillPipeline(
      manyInput(),
      {
        agent: agentOk(DOSSIER),
        oneShot: async (p): Promise<HeadlessResult> => {
          if (!p.includes('# Candidate'))
            return {
              text: p.includes('# Dossier (established') ? manyCands() : SUMMARY,
              usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, durationMs: 10 }
            }
          calls++
          // A clean return, then a cancel — nothing rejects, so only the early-exit can stop it.
          ac.abort()
          return {
            text: MAT,
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, durationMs: 10 }
          }
        }
      },
      undefined,
      ac.signal,
      { concurrency: 1 }
    )
    expect(calls).toBe(1)
    expect(run.stages?.materialize).toHaveLength(1)
    expect(run.output.proposals).toHaveLength(1)
    // the completed call's cost is still folded in
    expect(run.usage?.costUsd).toBeCloseTo(0.53)
  })

  it('a non-finite or sub-1 concurrency falls back to the default width', async () => {
    // Observable only with more than one candidate: with a single one, mapLimit's own clamp hides
    // a bad width. The resolution cap for 'solved' is 3, which is also MATERIALIZE_CONCURRENCY.
    const many = manyInput()
    const cands = manyCands()
    for (const concurrency of [Number.NaN, 0, -3]) {
      let inflight = 0
      let peak = 0
      const run = await runCaseDistillPipeline(
        many,
        {
          agent: agentOk(DOSSIER),
          oneShot: async (p): Promise<HeadlessResult> => {
            if (!p.includes('# Candidate'))
              return { text: p.includes('# Dossier (established') ? cands : SUMMARY }
            inflight++
            peak = Math.max(peak, inflight)
            await new Promise((r) => setTimeout(r, 5))
            inflight--
            return { text: MAT }
          }
        },
        undefined,
        undefined,
        { concurrency }
      )
      expect(run.output.proposals).toHaveLength(3)
      expect(peak).toBe(MATERIALIZE_CONCURRENCY)
    }
  })

  it('threads the abort signal to every runner', async () => {
    const ac = new AbortController()
    const seen: (AbortSignal | undefined)[] = []
    await runCaseDistillPipeline(
      INPUT,
      {
        agent: async (_p, o) => {
          seen.push(o.signal)
          return agentOk(DOSSIER)()
        },
        oneShot: async (p, o) => {
          seen.push(o?.signal)
          return { text: route(p) }
        }
      },
      undefined,
      ac.signal
    )
    expect(seen.length).toBe(4)
    expect(seen.every((s) => s === ac.signal)).toBe(true)
  })
})
