import { describe, expect, it } from 'vitest'
import { GROK_PROFILE } from '../profiles/grok'
import { createAcpNormalizer } from '../normalize'

/**
 * Task 8 (brief §Step 1-2): all argv/auth/model values here are plan-derived and unverified —
 * no `grok` binary exists in this environment to capture live behavior against (see
 * grok.ts's file-level comment). These tests pin the profile's own declared contract, not a
 * verified-correct external CLI.
 */
describe('GROK_PROFILE', () => {
  it('spawns grok with the agent stdio subcommand by default', () => {
    const spawn = GROK_PROFILE.spawn({})
    expect(spawn.command).toBe('grok')
    expect(spawn.args).toEqual(['agent', 'stdio'])
  })

  it('spawns the configured cliPath when provided', () => {
    const spawn = GROK_PROFILE.spawn({ cliPath: '/x' })
    expect(spawn.command).toBe('/x')
    expect(spawn.args).toEqual(['agent', 'stdio'])
  })

  it('declares grok-build as the only model', () => {
    expect(GROK_PROFILE.models).toEqual([{ slug: 'grok-build', name: 'Grok Build' }])
  })

  it('has no resolveModel hook', () => {
    expect(GROK_PROFILE.resolveModel).toBeUndefined()
  })

  it('does not require an explicit post-init session/set_model request', () => {
    expect(GROK_PROFILE.selectModelAfterStart).toBeFalsy()
  })

  it('declares the XAI_API_KEY env var for auth', () => {
    expect(GROK_PROFILE.auth.envVar).toBe('XAI_API_KEY')
  })

  it('ignores xAI-style extension updates (no live fixture exists; stand-in)', () => {
    // xAI's CLI may emit extension/vendor-specific `sessionUpdate` variants that don't
    // appear in the known 8 variants (EVIDENCE.md §4). The normalizer's default case
    // returns [] rather than throwing, so Grok sessions degrade gracefully when such
    // updates arrive. This test validates that behavior with a type-derived stand-in.
    const n = createAcpNormalizer({ resumed: false, model: 'grok-build' })
    const result = n.normalize(
      { sessionUpdate: 'x_ai_extension', _meta: { foo: 1 } },
      { caseId: 1, caseSlug: 'c', sessionId: 1, turnId: 1 }
    )
    expect(result).toEqual([])
  })
})
