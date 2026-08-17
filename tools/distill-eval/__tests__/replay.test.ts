import { describe, it, expect, vi } from 'vitest'
import { replayCase, contractResolver } from '../src/replay'
import { REPLAY_WORLD_UNAVAILABLE } from '../src/agentRunner'
import { caseDistillPromptHash } from '../../../app/src/main/services/distill/promptHash'
import type { DistillWorld } from '../../../app/src/shared/distill'
import { line } from './fixtures'

const WORLD: DistillWorld = {
  sessions: [{ id: 1, title: 'only session', messages: [{ role: 'user', content: 'NEEDLE' }] }]
}

/** A fake agent runner that records what it was handed and answers a parseable output. */
function recordingAgent(): {
  agent: (prompt: string, world: DistillWorld | null) => Promise<string>
  seen: { prompt: string; world: DistillWorld | null }[]
} {
  const seen: { prompt: string; world: DistillWorld | null }[] = []
  return {
    seen,
    agent: async (prompt, world) => {
      seen.push({ prompt, world })
      return '```json\n{"summary": {"signature": "s", "symptoms": "s", "rootCause": "r", "fix": "f", "keywords": ["k"]}}\n```'
    }
  }
}

describe('replayCase', () => {
  it('reuses the stored output without a model call when hashes match', async () => {
    const oneShot = vi.fn(async () => '')
    const { agent, seen } = recordingAgent()
    const r = await replayCase(line({ promptHash: caseDistillPromptHash() }), { oneShot, agent })
    expect(oneShot).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
    expect(r.reused).toBe(true)
    expect(r.degradedReplay).toBe(false)
    expect(r.parsed?.summary?.signature).toBe('s')
  })

  it('runs the candidate prompt when hashes differ and reports a parse failure', async () => {
    const r = await replayCase(line(), { oneShot: async () => '', agent: async () => 'no fence here' })
    expect(r.reused).toBe(false)
    expect(r.parsed).toBeNull()
    expect(r.parseError).toMatch(/json fence/)
  })

  it('agent-replays a v2 line over its frozen world — not degraded, never the one-shot runner', async () => {
    const l = line()
    l.job.inputSnapshot.world = WORLD
    const oneShot = vi.fn(async () => 'MUST NOT BE USED')
    const { agent, seen } = recordingAgent()

    const r = await replayCase(l, { oneShot, agent })

    expect(oneShot).not.toHaveBeenCalled()
    expect(seen).toHaveLength(1)
    // the exact frozen world object rides through — replay serves the same snapshot the live run did
    expect(seen[0].world).toBe(WORLD)
    expect(seen[0].prompt).toContain('nav-1')
    expect(r.reused).toBe(false)
    expect(r.degradedReplay).toBe(false)
    expect(r.parseError).toBeNull()
  })

  it('flags a pre-v2 line (no world key) as a degraded replay and hands the agent null', async () => {
    const l = line()
    expect(l.job.inputSnapshot.world).toBeUndefined()
    const { agent, seen } = recordingAgent()

    const r = await replayCase(l, { oneShot: async () => '', agent })

    expect(seen).toHaveLength(1)
    expect(seen[0].world).toBeNull()
    expect(r.degradedReplay).toBe(true)
    expect(r.reused).toBe(false)
    expect(r.parseError).toBeNull()
    // the distinguished answer the tools give a degraded replay is a harness constant, not prose
    expect(REPLAY_WORLD_UNAVAILABLE).toContain('unavailable')
  })

  it('contractResolver overrides only the contract id and changes the candidate hash', () => {
    const resolve = contractResolver('NEW CONTRACT')!
    expect(resolve('headless.case-distill.contract')).toBe('NEW CONTRACT')
    expect(resolve('headless.case-distill.section.case')).toBe('# Case')
    expect(caseDistillPromptHash(resolve)).not.toBe(caseDistillPromptHash())
    expect(contractResolver(null)).toBeUndefined()
  })
})
