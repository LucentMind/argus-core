import { describe, it, expect } from 'vitest'
import { DRIVERS as MAIN_DRIVERS, resolveDriver, resolveInstanceDriver } from '../driverRegistry'
import {
  DRIVERS as SHARED_DRIVERS,
  activeDriver,
  capabilitiesFor,
  defaultInstanceId
} from '../../../../shared/drivers'
import { settingsSchema, type AppSettings } from '../../../../shared/settings'

/**
 * There are two hand-maintained driver catalogs and they cannot import each other:
 * `main/services/agent/driverRegistry.ts` holds the CONSTRUCTED drivers (what actually
 * runs a session), and `shared/drivers.ts` holds the renderer-visible DEFINITIONS (model
 * catalogs, config forms, advertised capabilities) — shared/ may never import from main/.
 *
 * Nothing else enforces that they agree, so this file is the seam's contract: key parity
 * and capability parity are asserted, and the ONE place they deliberately answer
 * differently — the disabled-instance fallback — is pinned with its rationale so a future
 * change to either side has to come through here.
 */

/** Settings with the named default instance present but DISABLED, and nothing else enabled. */
function nothingEnabled(namedDriver: string, namedId = 'named-1'): AppSettings {
  return settingsSchema.parse({
    agent: {
      activeInstanceId: namedId,
      providerInstances: {
        [namedId]: { driver: namedDriver, enabled: false, config: {} }
      }
    }
  })
}

describe('driver catalog parity: main driverRegistry vs shared/drivers', () => {
  it('registers exactly the same driver kinds on both sides', () => {
    const main = Object.keys(MAIN_DRIVERS).sort()
    const shared = Object.keys(SHARED_DRIVERS).sort()
    expect(main).toEqual(shared)
    // Spelled out so a diff shows WHICH kind moved, not just that the arrays differ.
    expect(shared).toEqual(['claude-agent-sdk', 'codex', 'cursor', 'github-copilot', 'grok'])
  })

  it('each catalog keys every driver by its own `kind`', () => {
    for (const [key, d] of Object.entries(SHARED_DRIVERS)) expect(d.kind).toBe(key)
    for (const [key, d] of Object.entries(MAIN_DRIVERS)) expect(d.kind).toBe(key)
  })

  it('declares identical capabilities on both sides for every driver', () => {
    // main's DriverCapabilities documents each flag as "mirrors the shared
    // DriverDefinition flag"; the existing per-driver contract tests only cross-check
    // headlessOneShot, which let planMode drift unnoticed on copilot and codex.
    for (const key of Object.keys(SHARED_DRIVERS)) {
      const shared = SHARED_DRIVERS[key].capabilities
      const main = MAIN_DRIVERS[key].capabilities
      expect({ kind: key, ...main }).toEqual({ kind: key, ...shared })
    }
  })
})

describe('disabled-instance fallback: a DELIBERATE divergence, pinned', () => {
  // The two sides answer different questions, so they are allowed to differ here:
  //
  //   main   — "which driver will actually run this session?" It must name a real,
  //            runnable driver, so resolveInstanceDriver short-circuits on `!enabled`
  //            and returns the Claude fallback. Disabling a provider must never strand
  //            a session.
  //   shared — "what affordances may the UI offer?" defaultInstanceId has no enabled
  //            instance to return, so it falls through to the named-but-disabled id, and
  //            activeDriver reports THAT instance's real driver.
  //
  // This is safe in exactly one direction, asserted below: Claude is the most permissive
  // driver, so shared's answer can only ever be equal-or-more-conservative than what main
  // actually runs. The UI may therefore withhold an affordance the running driver would
  // have supported (a lost convenience) but can never offer one that gets silently
  // dropped (a false "your edit applied" signal). Do not "fix" this by making shared fall
  // back to Claude — that would trade the safe direction for the unsafe one.

  it('with nothing enabled, main falls back to Claude while shared reports the disabled instance driver', () => {
    const s = nothingEnabled('github-copilot')
    // shared: no enabled instance, so defaultInstanceId returns the named (disabled) one
    expect(defaultInstanceId(s)).toBe('named-1')
    expect(activeDriver(s)?.kind).toBe('github-copilot')
    // main: short-circuits on !enabled
    expect(resolveDriver(s.agent).driver.kind).toBe('claude-agent-sdk')
    expect(resolveDriver(s.agent).unknownSlug).toBeUndefined()
  })

  it('a session pinned to a since-disabled instance resolves the same way', () => {
    const s = nothingEnabled('codex', 'codex-1')
    expect(resolveInstanceDriver(s.agent, 'codex-1').driver.kind).toBe('claude-agent-sdk')
    expect(capabilitiesFor(s, 'codex-1')).toBe(SHARED_DRIVERS['codex'].capabilities)
  })

  it('shared is never MORE permissive than main on editableApprovals in that state', () => {
    for (const kind of Object.keys(SHARED_DRIVERS)) {
      const s = nothingEnabled(kind)
      const advertised = activeDriver(s)!.capabilities.editableApprovals
      const running = resolveDriver(s.agent).driver.capabilities.editableApprovals
      expect(advertised && !running).toBe(false)
    }
  })

  it('agrees as soon as any instance is enabled — the divergence is confined to the empty case', () => {
    for (const kind of Object.keys(SHARED_DRIVERS)) {
      const s = settingsSchema.parse({
        agent: {
          activeInstanceId: 'named-1',
          providerInstances: { 'named-1': { driver: kind, enabled: true, config: {} } }
        }
      })
      expect(defaultInstanceId(s)).toBe('named-1')
      expect(resolveDriver(s.agent).driver.kind).toBe(activeDriver(s)!.kind)
    }
  })

  it('also agrees when the named default is disabled but another instance is enabled', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'copilot-1',
        providerInstances: {
          'copilot-1': { driver: 'github-copilot', enabled: false, config: {} },
          'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} }
        }
      }
    })
    expect(defaultInstanceId(s)).toBe('claude-default')
    expect(resolveDriver(s.agent).driver.kind).toBe(activeDriver(s)!.kind)
  })

  it('an unknown driver slug: main flags it and still falls back; shared reports null', () => {
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'weird-1',
        providerInstances: { 'weird-1': { driver: 'mystery-driver', enabled: true, config: {} } }
      }
    })
    const resolved = resolveDriver(s.agent)
    expect(resolved.driver.kind).toBe('claude-agent-sdk')
    expect(resolved.unknownSlug).toBe('mystery-driver')
    expect(activeDriver(s)).toBeNull()
  })
})
