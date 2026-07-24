import { describe, expect, it } from 'vitest'
import { CURSOR_PROFILE } from '../profiles/cursor'

/**
 * Task 7 (brief §Step 1-2): all argv/auth/model values here are plan-derived and unverified —
 * no `cursor-agent` binary exists in this environment to capture live behavior against (see
 * cursor.ts's file-level comment). These tests pin the profile's own declared contract, not a
 * verified-correct external CLI.
 */
describe('CURSOR_PROFILE', () => {
  it('spawns cursor-agent with the acp subcommand by default', () => {
    const spawn = CURSOR_PROFILE.spawn({})
    expect(spawn.command).toBe('cursor-agent')
    expect(spawn.args).toEqual(['acp'])
  })

  it('spawns the configured cliPath when provided', () => {
    const spawn = CURSOR_PROFILE.spawn({ cliPath: '/x' })
    expect(spawn.command).toBe('/x')
    expect(spawn.args).toEqual(['acp'])
  })

  it('resolveModel collapses known aliases to their base model id', () => {
    expect(CURSOR_PROFILE.resolveModel?.('composer')).toBe('composer-2')
    expect(CURSOR_PROFILE.resolveModel?.('composer-1')).toBe('composer-1.5')
  })

  it('resolveModel passes already-resolved/unknown slugs through unchanged', () => {
    expect(CURSOR_PROFILE.resolveModel?.('auto')).toBe('auto')
    expect(CURSOR_PROFILE.resolveModel?.('composer-2')).toBe('composer-2')
  })

  it('requires an explicit post-init session/set_model request', () => {
    expect(CURSOR_PROFILE.selectModelAfterStart).toBe(true)
  })

  it('declares the CURSOR_API_KEY env var for auth', () => {
    expect(CURSOR_PROFILE.auth.envVar).toBe('CURSOR_API_KEY')
  })
})
