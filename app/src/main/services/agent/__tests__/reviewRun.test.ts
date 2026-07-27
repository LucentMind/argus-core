import { describe, it, expect } from 'vitest'
import { buildReviewRunPrompt } from '../reviewRun'
import { REVIEW_LAYERS, CANDIDATE_CONTRACT } from '../../../../shared/reviewLayers'

const base = {
  prUrl: 'https://github.com/o/r/pull/7',
  worktreePath: '/wt/r-case-pr7'
}

describe('buildReviewRunPrompt', () => {
  it('names the PR and the worktree', () => {
    const p = buildReviewRunPrompt({ ...base, support: 'configurable', pinnedLayers: [] })
    expect(p).toContain('https://github.com/o/r/pull/7')
    expect(p).toContain('/wt/r-case-pr7')
  })

  it('on a configurable driver delegates by agent name and does not inline layer prompts', () => {
    const p = buildReviewRunPrompt({ ...base, support: 'configurable', pinnedLayers: [] })
    expect(p).toContain('review-correctness')
    expect(p).toContain('review-design-conformance')
    expect(p).not.toContain(REVIEW_LAYERS.correctness.prompt)
  })

  it("on a promptable driver inlines each layer's investigative task", () => {
    const p = buildReviewRunPrompt({ ...base, support: 'promptable', pinnedLayers: [] })
    expect(p).toContain('chase every suspicion')
    expect(p).toContain('trace where untrusted input reaches')
  })

  // Finding 1 (layered-review review): the promptable path used to inline the delegate-only
  // CANDIDATE_CONTRACT verbatim ("Return candidates only — do NOT record findings. You have no
  // findings tool… Emit nothing else.") into the SAME turn as the agent that runs the passes
  // itself and IS told to call append_finding a few paragraphs later. That is the only path for
  // Codex, Cursor and Grok (promptable drivers), so the contradiction was not a corner case.
  it('on a promptable driver never tells the recording agent it has no findings tool', () => {
    const p = buildReviewRunPrompt({ ...base, support: 'promptable', pinnedLayers: [] })
    expect(p).not.toContain(CANDIDATE_CONTRACT)
    expect(p).not.toMatch(/no findings tool/i)
    expect(p).not.toMatch(/do NOT record findings/i)
    // The turn still tells the agent it DOES have and should use append_finding — via the
    // shared triage text that already follows the fan-out section for both driver kinds.
    expect(p).toMatch(/append_finding/)
  })

  // Follow-up from the layered-review review: nothing asserted that the configurable fan-out
  // text actually tells the delegating agent WHAT to hand each subagent — a prompt override or
  // a careless edit to `fanout-configurable` could silently drop that and reopen the finding
  // that a layer subagent starts with no context of its own.
  it('tells a configurable driver to state the worktree path and diff scope when delegating', () => {
    const p = buildReviewRunPrompt({ ...base, support: 'configurable', pinnedLayers: [] })
    expect(p).toMatch(/worktree path/i)
    expect(p).toMatch(/diff scope/i)
  })

  it('lets the agent choose when nothing is pinned', () => {
    const p = buildReviewRunPrompt({ ...base, support: 'configurable', pinnedLayers: [] })
    expect(p).toContain(REVIEW_LAYERS.security.appliesWhen)
  })

  it('restricts to the pinned layers and says they were chosen by the user', () => {
    const p = buildReviewRunPrompt({
      ...base,
      support: 'configurable',
      pinnedLayers: ['security']
    })
    expect(p).toContain('review-security')
    expect(p).not.toContain('review-tests')
    expect(p).toMatch(/user (pinned|selected|asked)/i)
  })

  it('always carries the triage contract', () => {
    for (const support of ['configurable', 'promptable'] as const) {
      const p = buildReviewRunPrompt({ ...base, support, pinnedLayers: [] })
      expect(p).toMatch(/dedup/i)
      expect(p).toMatch(/refute/i)
      expect(p).toMatch(/append_finding/)
    }
  })

  it('routes its own scaffolding through the resolver', () => {
    const seen: string[] = []
    buildReviewRunPrompt({
      ...base,
      support: 'configurable',
      pinnedLayers: [],
      resolve: (id) => {
        seen.push(id)
        return 'X'
      }
    })
    expect(seen).toContain('review.run.header')
    expect(seen).toContain('review.run.triage')
  })
})
