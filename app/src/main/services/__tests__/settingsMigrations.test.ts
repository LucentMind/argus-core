import { describe, it, expect, vi } from 'vitest'
import {
  migrateBypassDefault,
  migrateDefaultRepoToList,
  type MigratableSettings
} from '../settingsMigrations'
import {
  defaultSettings,
  deepMerge,
  settingsSchema,
  type AppSettings,
  type PermissionMode
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
    for (const mode of ['default', 'acceptEdits', 'plan'] as PermissionMode[]) {
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
