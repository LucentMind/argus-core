import { describe, it, expect, vi } from 'vitest'
import {
  migrateBypassDefault,
  migrateDefaultRepoToList,
  migrateRelatedSearchSwitches,
  migrateFavoritesRanking,
  type MigratableSettings
} from '../settingsMigrations'
import {
  defaultSettings,
  deepMerge,
  settingsSchema,
  PERMISSION_MODES,
  type AppSettings
} from '../../../shared/settings'

/** DI stand-in for SettingsService: same `get`/`patch` contract, and `patch` runs the REAL
 *  deepMerge + schema parse the service uses, so "does this clobber anything else?" is a
 *  question this fake can actually answer. No vi.mock('electron') anywhere. */
function fakeSettings(seed: (s: AppSettings) => void = () => undefined): MigratableSettings & {
  writes: number
} {
  let state = defaultSettings()
  seed(state)
  state = settingsSchema.parse(state)
  return {
    writes: 0,
    get: () => state,
    patch(p: unknown): AppSettings {
      this.writes++
      state = settingsSchema.parse(deepMerge(state, p))
      return state
    }
  }
}

const NOW = (): Date => new Date('2026-08-01T00:00:00.000Z')

describe('migrateBypassDefault', () => {
  it('resets a stored bypassPermissions default and stamps that it ran', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const s = fakeSettings((v) => {
        v.agent.defaultPermissionMode = 'bypassPermissions'
      })
      migrateBypassDefault(s, NOW)
      expect(s.get().agent.defaultPermissionMode).toBe('default')
      expect(s.get().migrations.bypassDefaultReset).toBe('2026-08-01T00:00:00.000Z')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves every other permission mode exactly as it was', () => {
    for (const mode of PERMISSION_MODES.filter((m) => m !== 'bypassPermissions')) {
      const s = fakeSettings((v) => {
        v.agent.defaultPermissionMode = mode
      })
      migrateBypassDefault(s, NOW)
      expect(s.get().agent.defaultPermissionMode).toBe(mode)
      // still stamped — otherwise it would re-run and reset a later deliberate choice
      expect(s.get().migrations.bypassDefaultReset).toBe('2026-08-01T00:00:00.000Z')
    }
  })

  it('runs once: a bypass mode chosen deliberately AFTER the migration survives', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const s = fakeSettings((v) => {
        v.agent.defaultPermissionMode = 'bypassPermissions'
      })
      migrateBypassDefault(s, NOW)
      // the user re-selects it on purpose, now that it genuinely does something
      s.patch({ agent: { defaultPermissionMode: 'bypassPermissions' } })
      const writesBefore = s.writes

      migrateBypassDefault(s, NOW)

      expect(s.get().agent.defaultPermissionMode).toBe('bypassPermissions')
      // idempotent right down to not writing at all
      expect(s.writes).toBe(writesBefore)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('touches nothing but the mode and its stamp', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const s = fakeSettings((v) => {
        v.agent.defaultPermissionMode = 'bypassPermissions'
        v.agent.activeInstanceId = 'claude-2'
        v.agent.maxSessions = 7
        v.agent.personaAppend = 'be terse'
        v.general.defaultRepo = 'org/repo'
        v.hivemind.repo = 'org/hive'
      })
      const before = s.get()
      migrateBypassDefault(s, NOW)
      const after = s.get()

      expect(after.agent.activeInstanceId).toBe('claude-2')
      expect(after.agent.maxSessions).toBe(7)
      expect(after.agent.personaAppend).toBe('be terse')
      expect(after.general).toEqual(before.general)
      expect(after.hivemind).toEqual(before.hivemind)
      expect(after.observability).toEqual(before.observability)
      expect(after.onboarding).toEqual(before.onboarding)
      expect(after.agent.providerInstances).toEqual(before.agent.providerInstances)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('migrateDefaultRepoToList', () => {
  it('moves a legacy single defaultRepo into defaultRepos and stamps that it ran', () => {
    const s = fakeSettings((st) => {
      st.general.defaultRepo = 'C:\\repos\\argus-core'
    })
    migrateDefaultRepoToList(s, NOW)
    expect(s.get().general.defaultRepos).toEqual(['C:\\repos\\argus-core'])
    expect(s.get().general.defaultRepo).toBeNull()
    expect(s.get().migrations.defaultRepoToList).toBe('2026-08-01T00:00:00.000Z')
  })

  it('stamps and clears even when there was no legacy value', () => {
    const s = fakeSettings()
    migrateDefaultRepoToList(s, NOW)
    expect(s.get().general.defaultRepos).toEqual([])
    expect(s.get().migrations.defaultRepoToList).toBe('2026-08-01T00:00:00.000Z')
  })

  it('is a no-op on a second run', () => {
    const s = fakeSettings((st) => {
      st.general.defaultRepo = 'C:\\repos\\argus-core'
    })
    migrateDefaultRepoToList(s, NOW)
    const writesAfterFirst = s.writes
    // a list the user has since emptied on purpose must stay empty
    s.patch({ general: { defaultRepos: [] } })
    migrateDefaultRepoToList(s, NOW)
    expect(s.writes).toBe(writesAfterFirst + 1) // only the explicit patch above
    expect(s.get().general.defaultRepos).toEqual([])
  })

  it('does not clobber a defaultRepos list that is already populated', () => {
    const s = fakeSettings((st) => {
      st.general.defaultRepo = 'C:\\repos\\legacy'
      st.general.defaultRepos = ['C:\\repos\\a', 'C:\\repos\\b']
    })
    migrateDefaultRepoToList(s, NOW)
    expect(s.get().general.defaultRepos).toEqual(['C:\\repos\\a', 'C:\\repos\\b'])
    expect(s.get().general.defaultRepo).toBeNull()
  })
})

describe('migrateRelatedSearchSwitches', () => {
  it('carries a stored similarPastCasesEnabled across to the local-cases switch', () => {
    const s = fakeSettings((st) => {
      st.general.similarPastCasesEnabled = true
    })
    migrateRelatedSearchSwitches(s, NOW)
    expect(s.get().general.relatedIncludeLocalCases).toBe(true)
    // The master switch is untouched: its default (on) is what today's build already does.
    expect(s.get().general.relatedSearchOnOpen).toBe(true)
    expect(s.get().general.similarPastCasesEnabled).toBe(false) // key deleted, default reseeded
    expect(s.get().migrations.relatedSearchSwitches).toBe('2026-08-01T00:00:00.000Z')
  })

  it('leaves local cases off when the legacy flag was never set', () => {
    const s = fakeSettings()
    migrateRelatedSearchSwitches(s, NOW)
    expect(s.get().general.relatedIncludeLocalCases).toBe(false)
    expect(s.get().general.relatedSearchOnOpen).toBe(true)
    expect(s.get().migrations.relatedSearchSwitches).toBe('2026-08-01T00:00:00.000Z')
  })

  it('is a no-op on a second run, so a later opt-out is not undone', () => {
    const s = fakeSettings((st) => {
      st.general.similarPastCasesEnabled = true
    })
    migrateRelatedSearchSwitches(s, NOW)
    const writesAfterFirst = s.writes
    // the user turns local history back off, on purpose
    s.patch({ general: { relatedIncludeLocalCases: false } })
    migrateRelatedSearchSwitches(s, NOW)
    expect(s.writes).toBe(writesAfterFirst + 1) // only the explicit patch above
    expect(s.get().general.relatedIncludeLocalCases).toBe(false)
  })
})

// ── migrateFavoritesRanking ─────────────────────────────────────────────────────────────────
//
// `sortModels` now ranks favourites by their own list order; before, that order was just the
// order they were starred in and the effective ranking came from `modelOrder`/catalog position.
// Without this migration the semantic change would silently re-order every existing user's
// favourites — and move which model their next case opens on — at the first launch.
describe('migrateFavoritesRanking', () => {
  function withFavourites(
    prefs: { hiddenModels?: string[]; favoriteModels?: string[]; modelOrder?: string[] },
    enabled = true
  ): ReturnType<typeof fakeSettings> {
    return fakeSettings((v) => {
      v.agent.providerInstances['claude-1'] = {
        driver: 'claude-agent-sdk',
        enabled,
        config: {}
      }
      v.agent.modelPreferences['claude-1'] = {
        hiddenModels: prefs.hiddenModels ?? [],
        favoriteModels: prefs.favoriteModels ?? [],
        modelOrder: prefs.modelOrder ?? []
      }
    })
  }

  // The reporter's case: starred 4.8 first, but the old rule displayed (and seeded) Opus 5
  // first, from the static catalog's order. The list has to be rewritten to say so.
  it('rewrites the list into the order the old rule displayed, and stamps', () => {
    const s = withFavourites({ favoriteModels: ['claude-opus-4-8', 'claude-opus-5'] })
    migrateFavoritesRanking(s, NOW)
    expect(s.get().agent.modelPreferences['claude-1'].favoriteModels).toEqual([
      'claude-opus-5',
      'claude-opus-4-8'
    ])
    expect(s.get().migrations.favoritesRankByList).toBe('2026-08-01T00:00:00.000Z')
  })

  it('carries across a ranking the user had set with the arrows', () => {
    const s = withFavourites({
      favoriteModels: ['claude-opus-5', 'claude-haiku-4-5'],
      // the old rule ranked favourites by modelOrder, so this is what they actually saw
      modelOrder: ['claude-haiku-4-5', 'claude-opus-5']
    })
    migrateFavoritesRanking(s, NOW)
    expect(s.get().agent.modelPreferences['claude-1'].favoriteModels).toEqual([
      'claude-haiku-4-5',
      'claude-opus-5'
    ])
  })

  it('runs once — a later hand-ranking is not undone at the next launch', () => {
    const s = withFavourites({ favoriteModels: ['claude-opus-4-8', 'claude-opus-5'] })
    migrateFavoritesRanking(s, NOW)
    const writes = s.writes
    // the user then drags 4.8 back to the top
    s.patch({
      agent: {
        modelPreferences: {
          'claude-1': {
            hiddenModels: [],
            favoriteModels: ['claude-opus-4-8', 'claude-opus-5'],
            modelOrder: []
          }
        }
      }
    })
    migrateFavoritesRanking(s, NOW)
    expect(s.get().agent.modelPreferences['claude-1'].favoriteModels).toEqual([
      'claude-opus-4-8',
      'claude-opus-5'
    ])
    expect(s.writes).toBe(writes + 1) // the user's own write, and nothing from the migration
  })

  // The interaction with the alias migration, and the reason this one waits. An alias names no
  // static row, so ordering it would strand it at the bottom — permanently, since the stamp
  // makes this a one-shot. Better to do nothing and retry next launch.
  it('does nothing and does NOT stamp while a preference is still alias-keyed', () => {
    const s = withFavourites({ favoriteModels: ['claude-opus-4-8', 'opus[1m]'] })
    migrateFavoritesRanking(s, NOW)
    expect(s.get().agent.modelPreferences['claude-1'].favoriteModels).toEqual([
      'claude-opus-4-8',
      'opus[1m]'
    ])
    expect(s.get().migrations.favoritesRankByList).toBe('')
    expect(s.writes).toBe(0)
  })

  it('stamps with nothing to do when there are no preferences at all', () => {
    const s = fakeSettings()
    migrateFavoritesRanking(s, NOW)
    expect(s.get().migrations.favoritesRankByList).toBe('2026-08-01T00:00:00.000Z')
  })

  it('leaves an already-correctly-ordered list untouched but still stamps', () => {
    const s = withFavourites({ favoriteModels: ['claude-opus-5', 'claude-opus-4-8'] })
    migrateFavoritesRanking(s, NOW)
    expect(s.get().agent.modelPreferences['claude-1'].favoriteModels).toEqual([
      'claude-opus-5',
      'claude-opus-4-8'
    ])
    expect(s.get().migrations.favoritesRankByList).toBe('2026-08-01T00:00:00.000Z')
  })
})
