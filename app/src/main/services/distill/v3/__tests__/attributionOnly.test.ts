import { describe, it, expect } from 'vitest'
import { runAttributionOnly } from '../attributionOnly'
import { DOSSIER_LITE_CONTRACT } from '../dossier'
import { DistillAgentRunError } from '../../caseDistiller'
import { DISTILL_MAX_ITERATIONS } from '../../worldTools'
import type { CaseDistillInput } from '../../../../../shared/distill'
import type { HeadlessAgentResult, HeadlessResult } from '../../../agent/driver'

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
  skillsIndex: [],
  referencesIndex: [],
  rcaStructure: null,
  alreadyCaptured: { proposals: [] },
  world: { sessions: [] },
  assets: [
    {
      kind: 'skill',
      name: 'diag',
      tier: 'user',
      callCount: 1,
      firstSeen: { sessionId: 1, turnId: null }
    }
  ],
  caseOutcome: 'solved',
  caseDomain: 'NAV',
  options: { attribution: true }
} as unknown as CaseDistillInput
const DOSSIER =
  '```json\n{"scope":{"status":"closed","resolution":"solved","settled":true,"note":""},"root_cause":{"text":"rc","cites":[{"finding":7}]},"confirmed_fix":null,"rejected_hypotheses":[],"diagnostic_path":[],"durable_facts":[],"user_corrections":[]}\n```'
const ATTR =
  '```json\n{"verdicts":[{"kind":"skill","name":"diag","applied":true,"verdict":"helped","reason":"r","cites":[{"finding":7}]}]}\n```'

describe('runAttributionOnly', () => {
  it('runs the dossier with the lite contract at half budget, then only the attribution stage', async () => {
    const seen: { prompt: string; maxIterations: number }[] = []
    const oneShots: string[] = []
    const r = await runAttributionOnly(INPUT, {
      agent: async (prompt, opts): Promise<HeadlessAgentResult> => {
        seen.push({ prompt, maxIterations: opts.maxIterations })
        return {
          text: DOSSIER,
          turnCount: 1,
          toolCallCount: 0,
          trajectory: [],
          usage: { costUsd: 0.2, durationMs: 1 }
        }
      },
      oneShot: async (p): Promise<HeadlessResult> => {
        oneShots.push(p)
        return { text: ATTR, usage: { costUsd: 0.01, durationMs: 1 } }
      }
    })
    expect(seen[0].prompt.startsWith(DOSSIER_LITE_CONTRACT)).toBe(true)
    expect(seen[0].maxIterations).toBe(Math.ceil(DISTILL_MAX_ITERATIONS / 2))
    expect(oneShots).toHaveLength(1)
    expect(oneShots[0]).toContain('# Assets')
    expect(r.stages.dossier).toBeDefined()
    expect(r.stages.attribution?.error).toBeUndefined()
    expect(r.attribution?.verdicts[0]).toMatchObject({ name: 'diag', verdict: 'helped' })
    expect(r.usage?.costUsd).toBeCloseTo(0.21)
  })
  it('a dossier that fails to parse throws DistillAgentRunError carrying the dossier stage', async () => {
    await expect(
      runAttributionOnly(INPUT, {
        agent: async () => ({ text: 'nope', turnCount: 1, toolCallCount: 0, trajectory: [] }),
        oneShot: async () => ({ text: ATTR })
      })
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DistillAgentRunError && e.agentMeta?.stages?.dossier?.error !== undefined
    )
  })
  it('resolve() still overrides sections; only the dossier contract id is swapped for the lite one', async () => {
    const ids: string[] = []
    await runAttributionOnly(
      INPUT,
      {
        agent: async () => ({ text: DOSSIER, turnCount: 1, toolCallCount: 0, trajectory: [] }),
        oneShot: async () => ({ text: ATTR })
      },
      (id) => {
        ids.push(id)
        return id.endsWith('.contract') && id.includes('attribution') ? 'X' : `<${id}>`
      }
    )
    expect(ids).not.toContain('headless.case-distill.dossier.contract')
    expect(ids).toContain('headless.case-distill.dossier.section.case')
    expect(ids).toContain('headless.case-distill.attribution.contract')
  })
  it('an empty inventory skips BOTH model calls: no dossier is paid for when there is nothing to grade', async () => {
    let agentCalls = 0
    let oneShotCalls = 0
    const r = await runAttributionOnly(
      { ...INPUT, assets: [] },
      {
        agent: async () => {
          agentCalls++
          return { text: DOSSIER, turnCount: 1, toolCallCount: 0, trajectory: [] }
        },
        oneShot: async () => {
          oneShotCalls++
          return { text: ATTR }
        }
      }
    )
    expect(agentCalls).toBe(0)
    expect(oneShotCalls).toBe(0)
    expect(r.stages.attributionSkipped).toBe('no-assets')
    expect(r.attribution).toBeUndefined()
  })
  it('an open case is skipped as "open" before any model call (A7)', async () => {
    let calls = 0
    const r = await runAttributionOnly(
      { ...INPUT, caseOutcome: 'open' },
      {
        agent: async () => {
          calls++
          return { text: DOSSIER, turnCount: 1, toolCallCount: 0, trajectory: [] }
        },
        oneShot: async () => {
          calls++
          return { text: ATTR }
        }
      }
    )
    expect(calls).toBe(0)
    expect(r.stages.attributionSkipped).toBe('open')
    expect(r.attribution).toBeUndefined()
  })
  it('an attribution stage failure is recorded on the stage, not thrown', async () => {
    const r = await runAttributionOnly(INPUT, {
      agent: async () => ({ text: DOSSIER, turnCount: 1, toolCallCount: 0, trajectory: [] }),
      oneShot: async () => ({ text: 'not json' })
    })
    expect(r.stages.attribution?.error).toBeDefined()
    expect(r.attribution).toBeUndefined()
  })
})
