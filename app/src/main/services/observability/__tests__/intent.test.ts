import { describe, it, expect } from 'vitest'
import { seedFor } from '../intent'

/**
 * The seed is the ONLY input to a session's trace id in every sink. Seen live 2026-10-25 on a
 * shared Langfuse project: two installs' "session 1" (one from July, one from a smoke run that
 * day) landed in the same trace because the seed was the bare session row id. Every install
 * numbers its sessions from 1, so a company-wide backend would merge every install's session N.
 */
describe('seedFor', () => {
  it('scopes the session seed to the install, mirroring the distill seed shape (<id>@<qualifier>)', () => {
    expect(seedFor('51163f68-a399-4d6f-986c-51ac8dcbfd5a', 1)).toBe(
      'argus-session-1@51163f68-a399-4d6f-986c-51ac8dcbfd5a'
    )
  })

  it('gives the same session number a different seed on a different install', () => {
    expect(seedFor('install-a', 1)).not.toBe(seedFor('install-b', 1))
    expect(seedFor('install-a', 1)).toBe(seedFor('install-a', 1))
  })

  it('never produces the legacy unscoped seed, even for an empty install id', () => {
    // An empty id would silently fall back to the colliding pre-fix form. The exporter is only
    // built once a provider is enabled, and the install id is created at that moment, so an
    // empty id is a wiring bug — make it loud rather than let it merge traces.
    expect(() => seedFor('', 1)).toThrow(/install id/)
  })
})
