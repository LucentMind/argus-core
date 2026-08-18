import { describe, it, expect } from 'vitest'
import { runCaseDistillPipeline, type PipelineRunners } from '../pipeline'
import { DistillAgentRunError } from '../../caseDistiller'
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
    expect((seenAgentOpts[0] as { allowedTools: string[] }).allowedTools).toEqual([])
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
