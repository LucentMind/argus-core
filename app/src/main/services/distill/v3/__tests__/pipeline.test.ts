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
      {
        type: 'skill-new',
        target: 'diagnose-x',
        title: 'dup',
        reason: 'target-exists',
        stage: 'veto'
      }
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

  it('reports each phase in order, and a tool tick inside the dossier stage', async () => {
    const seen: { phase: string; detail?: string; toolCalls?: number }[] = []
    await runCaseDistillPipeline(
      INPUT,
      {
        agent: async (_p, opts) => {
          // Simulate the agent calling one world tool through the server we were handed.
          const server = opts.mcpServer as { instance: { connect: (t: unknown) => Promise<void> } }
          const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
          const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
          const [ct, st] = InMemoryTransport.createLinkedPair()
          const client = new Client({ name: 't', version: '1' })
          await Promise.all([client.connect(ct), server.instance.connect(st)])
          await client.callTool({ name: 'list_sessions', arguments: {} })
          await client.close()
          return agentOk(DOSSIER)()
        },
        oneShot: oneShotBy(route)
      },
      undefined,
      undefined,
      { onProgress: (u) => seen.push(u) }
    )
    expect(seen.map((u) => u.phase)).toEqual([
      'dossier',
      'dossier',
      'summary+candidates',
      'veto',
      'materialize',
      'validators'
    ])
    expect(seen[1]).toEqual({ phase: 'dossier', detail: 'list_sessions', toolCalls: 1 })
    expect(seen[4].detail).toBe('diagnose-x')
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

  it('prunes a dossier cite the input cannot back, dropping the item and counting it', async () => {
    // The model invented finding #99 — the snapshot only has #7. The cite is well-FORMED, so
    // parseDossier keeps it; only a check against the input can catch it. root_cause loses its
    // only cite and is nulled, which in turn strands the candidate that pointed at it.
    const invented = DOSSIER.replace('{"finding":7}', '{"finding":99}')
    const run = await runCaseDistillPipeline(INPUT, {
      agent: agentOk(invented),
      oneShot: oneShotBy(route)
    })
    expect(run.stages?.dossierUncitedDropped).toEqual({ root_cause: 1 })
    expect(run.output.proposals).toEqual([])
    expect(run.preStageDropped?.map((d) => d.reason)).toContain('malformed')
  })

  it('drops a candidate whose outline is not a string, and still materializes the rest', async () => {
    // One bad shape used to throw out of parseCandidates and fail the WHOLE run — the good
    // candidate beside it never reached materialize. It must now survive, and the drop must be
    // counted so the run panel can say the model went off-contract.
    const one = (over: object): object => ({
      kind: 'procedure',
      type: 'skill-edit',
      target: 'diagnose-x',
      title: 't',
      outline: 'o',
      evidence: ['root_cause'],
      related: [],
      generalization: 'g',
      routing_rationale: 'r',
      confidence: 0.9,
      ...over
    })
    const mixed =
      '```json\n' +
      JSON.stringify({
        candidates: [
          // Would otherwise be kept and materialized — only its outline shape disqualifies it.
          one({
            type: 'skill-new',
            target: 'diagnose-y',
            outline: { trigger: 't', actions: ['a'] }
          }),
          one({})
        ]
      }) +
      '\n```'
    const run = await runCaseDistillPipeline(INPUT, {
      agent: agentOk(DOSSIER),
      oneShot: oneShotBy((p) => (p.includes('# Dossier (established') ? mixed : route(p)))
    })
    expect(run.stages?.candidatesMalformedDropped).toBe(1)
    expect(run.output.proposals).toHaveLength(1)
    expect(run.stages?.materialize?.map((m) => m.target)).toEqual(['diagnose-x'])
    expect(run.preStageDropped).toEqual([])
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
    const drop = run.preStageDropped?.find((d) => d.reason === 'materialize-error')
    expect(drop?.target).toBe('diagnose-x')
    // Origin, not just reason: a materialize-error happens inside the materialize stage, not the
    // veto pass — `stripNodes` uses this to bucket the drop onto the right pipeline node.
    expect(drop?.stage).toBe('materialize')
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
    const drop = run.preStageDropped?.find((d) => d.reason === 'case-identifiers')
    expect(drop?.stage).toBe('validators')
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

  it('a non-parse throw after the dossier is still a DistillAgentRunError carrying the stages', async () => {
    // A prompt-BUILDER throw (here: a resolver that refuses to serve the materialize ids) is not
    // a stage parse failure, so nothing on the stage path catches it. Unwrapped it escapes as a
    // plain Error and the queue's failed row loses stages_json — the one column that says which
    // stage the run got to.
    const resolve = (id: string): string => {
      if (id.startsWith('headless.case-distill.materialize.')) throw new Error('prompt boom')
      return id
    }
    const err = await runCaseDistillPipeline(
      INPUT,
      {
        agent: agentOk(DOSSIER),
        oneShot: oneShotBy((p) =>
          p.includes('headless.case-distill.candidates.') ? CANDS : SUMMARY
        )
      },
      resolve
    ).catch((e) => e)
    expect(err).toBeInstanceOf(DistillAgentRunError)
    expect((err as Error).message).toBe('prompt boom')
    expect(err.agentMeta.stages.dossier.rawOutput).toBe(DOSSIER)
    expect(err.agentMeta.stages.candidates.rawOutput).toBe(CANDS)
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

describe('attribution stage', () => {
  const ASSETS = [
    {
      kind: 'skill' as const,
      name: 'diagnose-x',
      tier: 'user',
      callCount: 1,
      firstSeen: { sessionId: 1, turnId: null }
    }
  ]
  const ATTR =
    '```json\n{"verdicts":[{"kind":"skill","name":"diagnose-x","applied":true,"verdict":"helped","reason":"r","cites":[{"finding":7}]}]}\n```'
  const withAssets = (): CaseDistillInput => ({
    ...INPUT,
    assets: ASSETS,
    caseOutcome: 'solved',
    caseDomain: 'NAV',
    options: { attribution: true }
  })
  const stageOf = (p: string): 'attribution' | 'summary' | 'candidates' | 'materialize' =>
    p.includes('# Assets')
      ? 'attribution'
      : p.startsWith('You are writing the canonical case summary')
        ? 'summary'
        : p.startsWith('You are selecting durable-knowledge candidates')
          ? 'candidates'
          : 'materialize'
  const routed = (attr: string = ATTR): PipelineRunners['oneShot'] =>
    oneShotBy((p) => {
      const s = stageOf(p)
      return s === 'attribution'
        ? attr
        : s === 'summary'
          ? SUMMARY
          : s === 'candidates'
            ? CANDS
            : MAT
    })

  it('runs after the dossier, in parallel with summary and candidates, and returns pruned+completed verdicts', async () => {
    // A latch, not an ordering check: each stage-2 call parks until ALL THREE have arrived, so a
    // sequential implementation (attribution after Promise.all([summary, candidates])) deadlocks
    // instead of passing by coincidence.
    const inner = routed()
    const parked: Array<() => void> = []
    let inFlight = 0
    let maxInFlight = 0
    const oneShot: PipelineRunners['oneShot'] = async (prompt, o) => {
      const s = stageOf(prompt)
      if (s === 'materialize') return inner(prompt, o)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolveLatch) => {
        parked.push(resolveLatch)
        if (parked.length === 3) parked.forEach((r) => r())
      })
      inFlight--
      return inner(prompt, o)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `attribution did not run in parallel with summary and candidates (only ${parked.length}/3 stage-2 calls in flight)`
            )
          ),
        2000
      )
    })
    const run = await Promise.race([
      runCaseDistillPipeline(withAssets(), { agent: agentOk(DOSSIER), oneShot }),
      timeout
    ]).finally(() => clearTimeout(timer))
    expect(maxInFlight).toBe(3)
    expect(run.stages?.attribution?.error).toBeUndefined()
    expect(run.attribution?.verdicts).toEqual([
      {
        kind: 'skill',
        name: 'diagnose-x',
        applied: true,
        verdict: 'helped',
        reason: 'r',
        cites: [{ finding: 7 }]
      }
    ])
    expect(run.stages?.attribution?.promptHash).toMatch(/^[0-9a-f]{12}$/)
    // dossier 0.5 + summary + candidates + attribution + 1 materialize at 0.01 each
    expect(run.usage?.costUsd).toBeCloseTo(0.54)
  })

  it('is skipped with a marker when the inventory is empty or the job declined it — no model call', async () => {
    const calls: string[] = []
    const inner = routed()
    const oneShot: PipelineRunners['oneShot'] = async (p, o) => {
      calls.push(p)
      return inner(p, o)
    }
    const empty = await runCaseDistillPipeline(
      { ...withAssets(), assets: [] },
      { agent: agentOk(DOSSIER), oneShot }
    )
    expect(empty.stages?.attributionSkipped).toBe('no-assets')
    expect(empty.stages?.attribution).toBeUndefined()
    expect(empty.attribution).toBeUndefined()
    const declined = await runCaseDistillPipeline(
      { ...withAssets(), options: { attribution: false } },
      { agent: agentOk(DOSSIER), oneShot }
    )
    expect(declined.stages?.attributionSkipped).toBe('declined')
    expect(declined.attribution).toBeUndefined()
    expect(calls.some((p) => p.includes('# Assets'))).toBe(false)
  })

  it('is skipped as "open" on an open case — no model call, even with assets (A7)', async () => {
    const calls: string[] = []
    const inner = routed()
    const oneShot: PipelineRunners['oneShot'] = async (p, o) => {
      calls.push(p)
      return inner(p, o)
    }
    const run = await runCaseDistillPipeline(
      { ...withAssets(), caseOutcome: 'open' },
      { agent: agentOk(DOSSIER), oneShot }
    )
    expect(run.stages?.attributionSkipped).toBe('open')
    expect(run.stages?.attribution).toBeUndefined()
    expect(run.attribution).toBeUndefined()
    expect(calls.some((p) => p.includes('# Assets'))).toBe(false)
    expect(run.output.proposals?.length).toBeGreaterThan(0)
  })

  it('a parse failure is recorded on the stage and the run still completes with proposals', async () => {
    const run = await runCaseDistillPipeline(withAssets(), {
      agent: agentOk(DOSSIER),
      oneShot: routed('garbage')
    })
    expect(run.stages?.attribution?.error).toMatch(/json fence/)
    expect(run.attribution).toBeUndefined()
    expect(run.output.proposals?.length).toBeGreaterThan(0)
  })

  it('a runner error on the attribution call is recorded and the run still completes', async () => {
    const inner = routed()
    const oneShot: PipelineRunners['oneShot'] = async (p, o) => {
      if (stageOf(p) === 'attribution') throw new Error('boom')
      return inner(p, o)
    }
    const run = await runCaseDistillPipeline(withAssets(), { agent: agentOk(DOSSIER), oneShot })
    expect(run.stages?.attribution?.error).toBe('boom')
    expect(run.attribution).toBeUndefined()
    expect(run.output.proposals?.length).toBeGreaterThan(0)
  })

  it('records unknown-asset, malformed and uncited drop counters on stages', async () => {
    const bad =
      '```json\n{"verdicts":[{"kind":"skill","name":"nope","applied":true,"verdict":"helped","reason":"r","cites":[{"finding":7}]},{"kind":"skill","name":"diagnose-x","applied":true,"verdict":"helped","reason":"r","cites":[{"finding":999}]}]}\n```'
    const run = await runCaseDistillPipeline(withAssets(), {
      agent: agentOk(DOSSIER),
      oneShot: routed(bad)
    })
    expect(run.stages?.attributionUnknownAssetDropped).toEqual({ 'skill/nope': 1 })
    expect(run.stages?.attributionUncitedDropped).toBe(1)
    expect(run.attribution?.verdicts).toEqual([
      { kind: 'skill', name: 'diagnose-x', applied: null, verdict: null, reason: '', cites: [] }
    ])
  })

  it('a prompt-build throw is recorded on the attribution stage; the run still completes with proposals', async () => {
    // A resolver that refuses the attribution assets section ONCE: the throw happens in
    // buildAttributionPrompt, before summary/candidates are paid for. It must not fail the run.
    // (Once, because the stage's own promptHash re-resolves the same ids for the error record.)
    let refused = false
    const resolve = (id: string): string => {
      if (id === 'headless.case-distill.attribution.section.assets' && !refused) {
        refused = true
        throw new Error('assets boom')
      }
      return id
    }
    const run = await runCaseDistillPipeline(
      withAssets(),
      {
        agent: agentOk(DOSSIER),
        oneShot: oneShotBy((p) =>
          p.includes('headless.case-distill.materialize.')
            ? MAT
            : p.includes('headless.case-distill.candidates.')
              ? CANDS
              : SUMMARY
        )
      },
      resolve
    )
    expect(run.stages?.attribution?.error).toBe('assets boom')
    expect(run.stages?.attribution?.promptChars).toBe(0)
    expect(run.stages?.attribution?.promptHash).toMatch(/^[0-9a-f]{12}$/)
    expect(run.attribution).toBeUndefined()
    expect(run.output.proposals?.length).toBeGreaterThan(0)
  })

  it('an abort during the attribution call rejects the run rather than recording a stage error', async () => {
    const ac = new AbortController()
    const inner = routed()
    const oneShot: PipelineRunners['oneShot'] = async (p, o) => {
      if (stageOf(p) === 'attribution') {
        ac.abort()
        throw new Error('cancelled')
      }
      return inner(p, o)
    }
    const err = await runCaseDistillPipeline(
      withAssets(),
      { agent: agentOk(DOSSIER), oneShot },
      undefined,
      ac.signal
    ).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('cancelled')
  })

  it('a failed candidates stage still carries the attribution record in the thrown meta', async () => {
    const inner = routed()
    const oneShot: PipelineRunners['oneShot'] = async (p, o) =>
      stageOf(p) === 'candidates' ? { text: 'garbage' } : inner(p, o)
    const err = await runCaseDistillPipeline(withAssets(), {
      agent: agentOk(DOSSIER),
      oneShot
    }).catch((e) => e)
    expect(err).toBeInstanceOf(DistillAgentRunError)
    expect((err as DistillAgentRunError).agentMeta?.stages?.attribution?.error).toBeUndefined()
    expect((err as DistillAgentRunError).agentMeta?.stages?.attribution?.rawOutput).toBe(ATTR)
  })

  it('a failed candidates stage carries the parsed verdicts on agentMeta.attribution', async () => {
    // The verdicts are already paid for when candidates fails; carrying them lets the queue write
    // the rows instead of hatching a second (lite dossier + attribution) run.
    const inner = routed()
    const oneShot: PipelineRunners['oneShot'] = async (p, o) =>
      stageOf(p) === 'candidates' ? { text: 'garbage' } : inner(p, o)
    const err = (await runCaseDistillPipeline(withAssets(), {
      agent: agentOk(DOSSIER),
      oneShot
    }).catch((e) => e)) as DistillAgentRunError
    expect(err).toBeInstanceOf(DistillAgentRunError)
    expect(err.agentMeta?.attribution?.verdicts).toEqual([
      {
        kind: 'skill',
        name: 'diagnose-x',
        applied: true,
        verdict: 'helped',
        reason: 'r',
        cites: [{ finding: 7 }]
      }
    ])
  })

  it('a non-parse throw after the attribution stage (the outer wrap) carries the verdicts too', async () => {
    const err = (await runCaseDistillPipeline(
      withAssets(),
      { agent: agentOk(DOSSIER), oneShot: routed() },
      undefined,
      undefined,
      {
        onProgress: (u) => {
          if (u.phase === 'veto') throw new Error('late boom')
        }
      }
    ).catch((e) => e)) as DistillAgentRunError
    expect(err).toBeInstanceOf(DistillAgentRunError)
    expect(err.message).toBe('late boom')
    expect(err.agentMeta?.attribution?.verdicts.map((v) => v.name)).toEqual(['diagnose-x'])
  })

  it('a dossier failure carries no attribution on agentMeta (the stage never ran)', async () => {
    const err = (await runCaseDistillPipeline(withAssets(), {
      agent: agentOk('not json'),
      oneShot: routed()
    }).catch((e) => e)) as DistillAgentRunError
    expect(err).toBeInstanceOf(DistillAgentRunError)
    expect(err.agentMeta?.attribution).toBeUndefined()
  })
})
