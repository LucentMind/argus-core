import { describe, it, expect, vi } from 'vitest'
import { replayCaseV3 } from '../src/replayV3'
import type { AgentRunner } from '../src/agentRunner'
import { caseDistillPipelineHash } from '../../../app/src/main/services/distill/v3/promptHash'
import type { DistillWorld } from '../../../app/src/shared/distill'
import {
  v3Line,
  v3Route as route,
  V3_CANDS as CANDS,
  V3_DOSSIER as DOSSIER,
  V3_WORLD as WORLD
} from './fixtures'

function recordingAgent(text: string, capSubtype?: string): {
  agent: AgentRunner
  seen: { prompt: string; world: DistillWorld | null }[]
} {
  const seen: { prompt: string; world: DistillWorld | null }[] = []
  return {
    seen,
    agent: async (prompt, world) => {
      seen.push({ prompt, world })
      return { text, ...(capSubtype ? { capSubtype } : {}) }
    }
  }
}

describe('replayCaseV3', () => {
  it('runs the whole staged pipeline over the frozen world and reports every stage', async () => {
    const { agent, seen } = recordingAgent(DOSSIER)
    const oneShot = vi.fn(async (p: string) => route(p))

    const r = await replayCaseV3(v3Line(), { agent, oneShot })

    expect(r.reused).toBe(false)
    expect(r.degradedReplay).toBe(false)
    expect(r.parseError).toBeNull()
    expect(r.parsed?.proposals).toHaveLength(1)
    expect(r.parsed?.summary?.signature).toBe('s')
    // stage 1 is the ONLY agentic call; 2a/2b + one materialize are one-shots
    expect(seen).toHaveLength(1)
    expect(seen[0].world).toBe(WORLD)
    expect(oneShot).toHaveBeenCalledTimes(3)
    expect(r.stages?.dossier?.rawOutput).toBe(DOSSIER)
    expect(r.stages?.candidates?.rawOutput).toBe(CANDS)
    expect(r.stages?.materialize?.[0].target).toBe('diagnose-x')
    expect(r.preStageDropped).toEqual([
      { type: 'skill-new', target: 'diagnose-x', title: 'dup', reason: 'target-exists' }
    ])
  })

  it('reuses the stored output and the stored stages when the pipeline hash matches', async () => {
    const agent = vi.fn(async () => ({ text: 'MUST NOT BE USED' }))
    const oneShot = vi.fn(async () => 'MUST NOT BE USED')
    const stages = { dossier: { promptHash: 'abc', promptChars: 1, rawOutput: DOSSIER } }

    const r = await replayCaseV3(v3Line({ promptHash: caseDistillPipelineHash(), stages }), {
      agent,
      oneShot
    })

    expect(agent).not.toHaveBeenCalled()
    expect(oneShot).not.toHaveBeenCalled()
    expect(r.reused).toBe(true)
    expect(r.degradedReplay).toBe(false)
    expect(r.parsed?.summary?.signature).toBe('s') // the fixture's stored rawOutput
    expect(r.stages).toBe(stages)
  })

  it('a reused line surfaces the drops the corpus recorded, not an empty list', async () => {
    // Reuse skips the run, so the only drops that exist are the ones the exported job carried.
    // Reporting none would read as "this prompt dropped nothing", the opposite of the truth.
    const dropped = [
      { type: 'skill-new', target: 'diagnose-x', title: 'dup', reason: 'target-exists' as const }
    ]
    const r = await replayCaseV3(
      v3Line({ promptHash: caseDistillPipelineHash(), dropped }),
      { agent: vi.fn(async () => ({ text: 'MUST NOT BE USED' })), oneShot: vi.fn(async () => '') }
    )
    expect(r.reused).toBe(true)
    expect(r.preStageDropped).toEqual(dropped)
  })

  it('a reused line with no recorded drops reports none rather than an empty array', async () => {
    const r = await replayCaseV3(v3Line({ promptHash: caseDistillPipelineHash() }), {
      agent: vi.fn(async () => ({ text: 'MUST NOT BE USED' })),
      oneShot: vi.fn(async () => '')
    })
    expect(r.preStageDropped).toBeUndefined()
  })

  it('a v2 hash never counts as reused — the pipeline hash folds in "v3"', async () => {
    const { agent } = recordingAgent(DOSSIER)
    const r = await replayCaseV3(v3Line({ promptHash: 'ffffffffffff' }), {
      agent,
      oneShot: async (p) => route(p)
    })
    expect(r.reused).toBe(false)
  })

  it('keeps the stages a failed run got through, and reports the failure as a parse error', async () => {
    const { agent } = recordingAgent('no fence at all')
    const r = await replayCaseV3(v3Line(), { agent, oneShot: async (p) => route(p) })

    expect(r.parsed).toBeNull()
    expect(r.parseError).toMatch(/dossier/)
    expect(r.stages?.dossier?.rawOutput).toBe('no fence at all')
    expect(r.stages?.candidates).toBeUndefined()
    expect(r.capSubtype).toBeUndefined()
  })

  it('surfaces a cut-off agent run as capSubtype instead of parsing its text', async () => {
    // The dossier text is perfectly parseable — only the cap flag tells this apart from a clean
    // run, which is exactly why it must ride through the adapter into the pipeline.
    const { agent } = recordingAgent(DOSSIER, 'error_max_turns')
    const r = await replayCaseV3(v3Line(), { agent, oneShot: async (p) => route(p) })

    expect(r.capSubtype).toBe('error_max_turns')
    expect(r.parsed).toBeNull()
    expect(r.parseError).toMatch(/budget exhausted/)
    expect(r.stages?.dossier?.error).toMatch(/error_max_turns/)
  })

  it('flags a line with no world as a degraded replay and hands the agent null', async () => {
    const { agent, seen } = recordingAgent(DOSSIER)
    const r = await replayCaseV3(v3Line({}, null), { agent, oneShot: async (p) => route(p) })

    expect(seen[0].world).toBeNull()
    expect(r.degradedReplay).toBe(true)
    expect(r.parseError).toBeNull()
  })

  it('reports a non-pipeline throw (a broken runner) as a parse error with no stages', async () => {
    const r = await replayCaseV3(v3Line(), {
      agent: async () => {
        throw new Error('agent replay returned no text')
      },
      oneShot: async (p) => route(p)
    })
    expect(r.parsed).toBeNull()
    expect(r.parseError).toBe('agent replay returned no text')
    expect(r.raw).toBe('')
    expect(r.stages).toBeUndefined()
  })
})
