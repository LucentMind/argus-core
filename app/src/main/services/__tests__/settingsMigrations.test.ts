import { describe, it, expect, vi } from 'vitest'
import {
  migrateBypassDefault,
  migrateDefaultRepoToList,
  migrateRelatedSearchSwitches,
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
