import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SettingsService } from '../../settings'
import { settingsPath } from '../../paths'
import { defaultModelRef } from '../../../../shared/drivers'
import {
  canonicalizeStoredModelPrefs,
  migrateModelPrefs,
  type ModelPrefsSettings
} from '../modelPrefs'
import {
  settingsSchema,
  type AppSettings,
  type ModelPreferences
} from '../../../../shared/settings'
import type { ModelOptionInfo } from '../../../../shared/runOptions'
// The real captured CLI catalog: the migration's whole job is to interpret what the CLI
// actually emits, so a hand-written stand-in could agree with a broken implementation.
import CLI_CATALOG from '../drivers/claude/__fixtures__/models-2-1-220.json'

const CATALOG = CLI_CATALOG as ModelOptionInfo[]

function store(prefs?: ModelPreferences): {
  get: () => AppSettings
  patch: Mock<(partial: unknown) => unknown>
  prefs: () => ModelPreferences | undefined
} {
  let settings = settingsSchema.parse({
    agent: {
      activeInstanceId: 'claude-1',
      providerInstances: {
        'claude-1': { driver: 'claude-agent-sdk', enabled: true, config: {} }
      },
      modelPreferences: prefs ? { 'claude-1': prefs } : {}
    }
  })
  const patch = vi.fn((partial: unknown): unknown => {
    const { agent } = partial as { agent: { modelPreferences: Record<string, ModelPreferences> } }
    settings = settingsSchema.parse({
      ...settings,
      agent: {
        ...settings.agent,
        modelPreferences: { ...settings.agent.modelPreferences, ...agent.modelPreferences }
      }
    })
    return settings
  })
  return { get: () => settings, patch, prefs: () => settings.agent.modelPreferences['claude-1'] }
}

// The reporter's actual settings.json, verbatim: Opus 5 starred while the catalog was loaded
// (so it stored the alias `opus[1m]`), Opus 4.8 starred as a wire slug because the CLI's alias
// menu never names 4.8. The alias half was invisible to the new-case seed.
const REPORTED: ModelPreferences = {
  hiddenModels: ['claude-sonnet-4-6', 'claude-opus-4-7'],
  favoriteModels: ['claude-opus-4-8', 'opus[1m]'],
  modelOrder: []
}

describe('canonicalizeStoredModelPrefs', () => {
  it('rewrites the reported alias-keyed favourite to its wire slug', () => {
    const s = store(REPORTED)
    expect(canonicalizeStoredModelPrefs(s, 'claude-1', CATALOG)).toBe(true)
    expect(s.prefs()?.favoriteModels).toEqual(['claude-opus-4-8', 'claude-opus-5'])
    // untouched lists survive the rewrite intact
    expect(s.prefs()?.hiddenModels).toEqual(['claude-sonnet-4-6', 'claude-opus-4-7'])
    expect(s.patch).toHaveBeenCalledTimes(1)
  })

  // It runs on every catalog fetch — several per launch, since the composer and the settings
  // panel both ask — so anything but a no-op on already-migrated data would rewrite
  // settings.json (and re-broadcast it to every window) for nothing.
  it('does not write when the stored prefs are already canonical', () => {
    const s = store({
      hiddenModels: ['claude-haiku-4-5'],
      favoriteModels: ['claude-opus-5'],
      modelOrder: []
    })
    expect(canonicalizeStoredModelPrefs(s, 'claude-1', CATALOG)).toBe(false)
    expect(s.patch).not.toHaveBeenCalled()
  })

  it('is idempotent: a second pass over its own output writes nothing', () => {
    const s = store(REPORTED)
    canonicalizeStoredModelPrefs(s, 'claude-1', CATALOG)
    expect(canonicalizeStoredModelPrefs(s, 'claude-1', CATALOG)).toBe(false)
    expect(s.patch).toHaveBeenCalledTimes(1)
  })

  it('does nothing for an instance with no stored preferences', () => {
    const s = store()
    expect(canonicalizeStoredModelPrefs(s, 'claude-1', CATALOG)).toBe(false)
    expect(s.patch).not.toHaveBeenCalled()
  })

  // The safety property that makes it safe to run unconditionally. `fetchCatalog` falls back to
  // a static list — or, offline, to an empty one — and neither can resolve an alias. Rewriting
  // against them must LEAVE the alias alone, never drop the preference: a failed CLI probe is
  // not evidence that the user unfavourited a model.
  it('preserves an unresolvable alias when the catalog is empty rather than dropping it', () => {
    const s = store(REPORTED)
    expect(canonicalizeStoredModelPrefs(s, 'claude-1', [])).toBe(false)
    expect(s.prefs()?.favoriteModels).toEqual(['claude-opus-4-8', 'opus[1m]'])
    expect(s.patch).not.toHaveBeenCalled()
  })
})

// ── the persistence seam ────────────────────────────────────────────────────────────────────
//
// Everything above runs against a fake store, which proves the rewrite and nothing about
// whether it SURVIVES. Between `patch()` and the next launch sit `deepMerge` (arrays replaced,
// not merged) and `stripDefaults` (drops anything equal to its default) — and a migration that
// is silently discarded on the way to disk, or discarded when the file is re-read, is worth
// exactly nothing. So this one goes through the real SettingsService and a real file, and ends
// on the user-visible claim: a new case is seeded with Opus 5.
describe('canonicalizeStoredModelPrefs through the real SettingsService', () => {
  let tmp: string
  const open = (home: string): SettingsService => new SettingsService(home)

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-modelprefs-'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('persists the rewrite to disk, survives a reload, and moves the new-case seed to Opus 5', () => {
    const home = path.join(tmp, 'home')
    fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true })
    // The reporter's settings.json, as found on disk.
    fs.writeFileSync(
      settingsPath(home),
      JSON.stringify({
        agent: {
          activeInstanceId: 'claude-agent-sdk-1',
          providerInstances: {
            'claude-agent-sdk-1': { driver: 'claude-agent-sdk', enabled: true, config: {} }
          },
          modelPreferences: { 'claude-agent-sdk-1': REPORTED }
        }
      })
    )

    const svc = open(home)
    // The defect, reproduced from the real file before anything is changed.
    expect(defaultModelRef(svc.get())?.slug).toBe('claude-opus-4-8')

    expect(canonicalizeStoredModelPrefs(svc, 'claude-agent-sdk-1', CATALOG)).toBe(true)

    // on disk, not just in memory — stripDefaults must not have eaten it
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(home), 'utf-8'))
    expect(onDisk.agent.modelPreferences['claude-agent-sdk-1'].favoriteModels).toEqual([
      'claude-opus-4-8',
      'claude-opus-5'
    ])
    svc.close()

    // and it re-parses on the next launch into the same thing
    const reopened = open(home)
    expect(reopened.get().agent.modelPreferences['claude-agent-sdk-1'].favoriteModels).toEqual([
      'claude-opus-4-8',
      'claude-opus-5'
    ])
    expect(reopened.get().agent.modelPreferences['claude-agent-sdk-1'].hiddenModels).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-7'
    ])
    // the point of the whole change
    expect(defaultModelRef(reopened.get())?.slug).toBe('claude-opus-5')
    reopened.close()
  })
})

// ── the boot migration ──────────────────────────────────────────────────────────────────────
//
// Placement matters as much as correctness here. Hanging the rewrite off the composer's catalog
// fetch would mean a user who launches and immediately creates a case — exactly the flow that
// produced this report — still gets one more case seeded from the stale prefs, because the
// composer only mounts after the case exists. So it runs at boot instead, gated so it costs
// nothing (no CLI spawn) for anyone with nothing to migrate.
describe('migrateModelPrefs', () => {
  function claudeSettings(prefs?: ModelPreferences, extra?: Record<string, unknown>): AppSettings {
    return settingsSchema.parse({
      agent: {
        activeInstanceId: 'claude-1',
        providerInstances: {
          'claude-1': { driver: 'claude-agent-sdk', enabled: true, config: {} },
          ...extra
        },
        modelPreferences: prefs ? { 'claude-1': prefs } : {}
      }
    })
  }

  function svc(settings: AppSettings): ModelPrefsSettings & { patch: Mock } {
    let cur = settings
    const patch = vi.fn((partial: unknown): unknown => {
      const { agent } = partial as { agent: { modelPreferences: Record<string, ModelPreferences> } }
      cur = settingsSchema.parse({
        ...cur,
        agent: {
          ...cur.agent,
          modelPreferences: { ...cur.agent.modelPreferences, ...agent.modelPreferences }
        }
      })
      return cur
    })
    return { get: () => cur, patch }
  }

  it('fetches once and rewrites the instance whose prefs cannot be resolved offline', async () => {
    const s = svc(claudeSettings(REPORTED))
    const fetch = vi.fn(async () => CATALOG)
    await migrateModelPrefs(s, fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('claude-1')
    expect(s.get().agent.modelPreferences['claude-1'].favoriteModels).toEqual([
      'claude-opus-4-8',
      'claude-opus-5'
    ])
  })

  // The gate, and the reason this can live at boot at all: no stale slug, no CLI spawn.
  it('does not fetch at all when every stored slug already resolves offline', async () => {
    const fetch = vi.fn(async () => CATALOG)
    await migrateModelPrefs(
      svc(claudeSettings({ hiddenModels: [], favoriteModels: ['claude-opus-5'], modelOrder: [] })),
      fetch
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not fetch for an instance with no stored preferences', async () => {
    const fetch = vi.fn(async () => CATALOG)
    await migrateModelPrefs(svc(claudeSettings()), fetch)
    expect(fetch).not.toHaveBeenCalled()
  })

  // Only the Claude driver has a runtime catalog; probing anything else would be spawning a
  // CLI that cannot answer the question.
  it('skips disabled and non-Claude instances', async () => {
    const fetch = vi.fn(async () => CATALOG)
    const s = settingsSchema.parse({
      agent: {
        activeInstanceId: 'copilot-1',
        providerInstances: {
          'copilot-1': { driver: 'github-copilot', enabled: true, config: {} },
          'claude-off': { driver: 'claude-agent-sdk', enabled: false, config: {} }
        },
        modelPreferences: {
          'copilot-1': { hiddenModels: [], favoriteModels: ['opus[1m]'], modelOrder: [] },
          'claude-off': { hiddenModels: [], favoriteModels: ['opus[1m]'], modelOrder: [] }
        }
      }
    })
    await migrateModelPrefs(svc(s), fetch)
    expect(fetch).not.toHaveBeenCalled()
  })

  // It is fire-and-forget at boot: a CLI that is missing, slow or broken must degrade to "not
  // migrated this launch", never to an unhandled rejection in the main process.
  it('swallows a failing catalog fetch and leaves the prefs alone', async () => {
    const s = svc(claudeSettings(REPORTED))
    const fetch = vi.fn(async () => {
      throw new Error('no CLI')
    })
    await expect(migrateModelPrefs(s, fetch)).resolves.toBeUndefined()
    expect(s.get().agent.modelPreferences['claude-1'].favoriteModels).toEqual([
      'claude-opus-4-8',
      'opus[1m]'
    ])
  })
})
