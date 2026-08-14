import { describe, it, expect } from 'vitest'
import {
  settingsSchema,
  defaultSettings,
  deepMerge,
  stripDefaults,
  SETTINGS_ATOMIC_PATHS,
  PERMISSION_MODES,
  BASE_PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  MODE_BY_LABEL,
  DEFAULT_WATERMARK_TEXT
} from '../settings'

describe('settings schema', () => {
  it('parses {} to full defaults including the claude-default instance', () => {
    const s = settingsSchema.parse({})
    expect(s.general.confirmCaseDelete).toBe(true)
    expect(s.general.similarPastCasesEnabled).toBe(false)
    expect(s.agent.activeInstanceId).toBe('claude-default')
    expect(s.agent.maxSessions).toBe(3)
    expect(s.agent.probeTimeoutMs).toBe(10000)
    expect(s.agent.defaultPermissionMode).toBe('default')
    expect(s.agent.personaAppend).toBe('')
    expect(s.agent.providerInstances['claude-default']).toEqual({
      driver: 'claude-agent-sdk',
      enabled: true,
      config: {}
    })
    expect(s.tools).toEqual({ traceDir: '', parseBin: '' })
  })

  it('fills inner defaults for partial nested input', () => {
    const s = settingsSchema.parse({ agent: { maxSessions: 5 } })
    expect(s.agent.maxSessions).toBe(5)
    expect(s.agent.probeTimeoutMs).toBe(10000)
  })

  it('passes through unknown keys at every level (forward compat)', () => {
    const s = settingsSchema.parse({
      future: { x: 1 },
      agent: { futureKey: 'y', maxSessions: 4 }
    }) as Record<string, unknown>
    expect((s.future as { x: number }).x).toBe(1)
    expect((s.agent as Record<string, unknown>).futureKey).toBe('y')
  })

  it('round-trips an unknown driver slug through providerInstances', () => {
    const s = settingsSchema.parse({
      agent: {
        providerInstances: {
          weird: { driver: 'future-driver', enabled: false, config: { secretShape: [1, 2] } }
        }
      }
    })
    expect(s.agent.providerInstances.weird.driver).toBe('future-driver')
    expect(s.agent.providerInstances.weird.config).toEqual({ secretShape: [1, 2] })
  })

  it('stripDefaults keeps only non-default leaves and unknown keys', () => {
    const s = settingsSchema.parse({ agent: { maxSessions: 5 }, future: { x: 1 } })
    const sparse = stripDefaults(s, defaultSettings()) as Record<string, unknown>
    expect(sparse).toEqual({ agent: { maxSessions: 5 }, future: { x: 1 } })
  })

  it('stripDefaults of pure defaults is {} and re-parses to defaults', () => {
    const sparse = stripDefaults(defaultSettings(), defaultSettings())
    expect(sparse).toEqual({})
    expect(settingsSchema.parse(sparse)).toEqual(defaultSettings())
  })

  it('deepMerge merges nested objects, replaces scalars, deletes on null', () => {
    const base = { a: { b: 1, c: 2 }, d: 'x', e: { f: 1 } }
    const out = deepMerge(base, { a: { b: 9 }, d: null, e: null }) as Record<string, unknown>
    expect(out).toEqual({ a: { b: 9, c: 2 } })
    expect(base.a.b).toBe(1) // no mutation
  })

  it('stripDefaults is key-order-insensitive', () => {
    const reordered = {
      agent: {
        providerInstances: {
          'claude-default': { config: {}, enabled: true, driver: 'claude-agent-sdk' }
        }
      }
    }
    const merged = settingsSchema.parse(reordered)
    expect(stripDefaults(merged, defaultSettings())).toEqual({})
  })

  it('stripDefaults handles deeply nested objects regardless of key order', () => {
    const result = stripDefaults({ a: { y: 2, x: 1 } }, { a: { x: 1, y: 2 } })
    expect(result).toEqual({})
  })

  it('stripDefaults drops array leaves equal to default regardless of inner key order', () => {
    expect(stripDefaults({ a: [{ y: 2, x: 1 }] }, { a: [{ x: 1, y: 2 }] })).toEqual({})
  })

  it('round-trips a config-level instance patch through strip + parse', () => {
    const patched = settingsSchema.parse(
      deepMerge(defaultSettings(), {
        agent: { providerInstances: { 'claude-default': { config: { model: 'claude-sonnet-5' } } } }
      })
    )
    const sparse = stripDefaults(patched, defaultSettings(), {
      atomicPaths: SETTINGS_ATOMIC_PATHS
    }) as Record<string, unknown>
    expect(settingsSchema.parse(sparse)).toEqual(patched)
    // the kept entry is verbatim — driver survives
    const agent = sparse.agent as Record<string, unknown>
    const providerInstances = agent.providerInstances as Record<string, Record<string, unknown>>
    expect(providerInstances['claude-default'].driver).toBe('claude-agent-sdk')
  })

  it('round-trips a displayName-level instance patch', () => {
    const patched = settingsSchema.parse(
      deepMerge(defaultSettings(), {
        agent: { providerInstances: { 'claude-default': { displayName: 'My Claude' } } }
      })
    )
    const sparse = stripDefaults(patched, defaultSettings(), { atomicPaths: SETTINGS_ATOMIC_PATHS })
    expect(settingsSchema.parse(sparse)).toEqual(patched)
  })

  it('still strips a pure-default instance map to {} with atomicPaths', () => {
    expect(
      stripDefaults(defaultSettings(), defaultSettings(), { atomicPaths: SETTINGS_ATOMIC_PATHS })
    ).toEqual({})
  })

  it('parses {} to an empty modelPreferences map', () => {
    expect(settingsSchema.parse({}).agent.modelPreferences).toEqual({})
  })

  it('modelPreferences entries round-trip through stripDefaults + parse with NO atomic treatment', () => {
    const patched = settingsSchema.parse(
      deepMerge(defaultSettings(), {
        agent: {
          modelPreferences: {
            'claude-default': {
              hiddenModels: [],
              favoriteModels: ['claude-opus-4-8'],
              modelOrder: ['claude-sonnet-5']
            }
          }
        }
      })
    )
    // deliberately NOT passing atomicPaths — unlike providerInstances (whose `driver` field has
    // no schema default and would break reparse if partially stripped), every modelPreferences
    // leaf is a defaultable array, so plain leaf-by-leaf stripping round-trips safely either way.
    const sparse = stripDefaults(patched, defaultSettings())
    expect(settingsSchema.parse(sparse)).toEqual(patched)
  })

  it('an emptied modelPreferences entry is NOT auto-dropped by stripDefaults — the caller must send null', () => {
    // The record's own default is {} (no known entries), so a runtime instance key is always an
    // "unknown key" to stripDefaultsAt and is preserved verbatim, even when every leaf is default.
    // This is why the UI (Task B) sends null for the whole entry once all three lists go empty.
    const patched = settingsSchema.parse(
      deepMerge(defaultSettings(), {
        agent: {
          modelPreferences: {
            'claude-default': { hiddenModels: [], favoriteModels: [], modelOrder: [] }
          }
        }
      })
    )
    const sparse = stripDefaults(patched, defaultSettings()) as Record<string, unknown>
    const agent = sparse.agent as Record<string, unknown>
    const prefs = agent.modelPreferences as Record<string, unknown>
    expect(prefs['claude-default']).toEqual({
      hiddenModels: [],
      favoriteModels: [],
      modelOrder: []
    })

    // explicit null deletion (the UI's job) does remove it, proving the escape hatch works
    const nulled = deepMerge(patched, {
      agent: { modelPreferences: { 'claude-default': null } }
    }) as Record<string, unknown>
    const nulledAgent = nulled.agent as Record<string, unknown>
    expect(
      (nulledAgent.modelPreferences as Record<string, unknown>)['claude-default']
    ).toBeUndefined()
  })

  it('deepMerge tolerates null / non-object patches (returns base unchanged)', () => {
    const base = { a: 1 }
    expect(deepMerge(base, null)).toEqual({ a: 1 })
    expect(deepMerge(base, undefined)).toEqual({ a: 1 })
  })

  it('hivemind.repo defaults to empty (dormant)', () => {
    const s = defaultSettings()
    expect(s.hivemind.repo).toBe('')
    const parsed = settingsSchema.parse({ hivemind: { repo: 'acme/hivemind' } })
    expect(parsed.hivemind.repo).toBe('acme/hivemind')
  })

  it('defaults general.defaultRepo to null and round-trips a set value', () => {
    const s = settingsSchema.parse({})
    expect(s.general.defaultRepo).toBeNull()
    const s2 = settingsSchema.parse({ general: { defaultRepo: 'C:/code/navigator' } })
    expect(s2.general.defaultRepo).toBe('C:/code/navigator')
  })

  it('defectCorpus.sources defaults to {}', () => {
    expect(defaultSettings().defectCorpus.sources).toEqual({})
  })

  it('round-trips a defectCorpus source entry through strip + parse', () => {
    const patched = settingsSchema.parse(
      deepMerge(defaultSettings(), {
        defectCorpus: {
          sources: {
            src1: { name: 'Hindsight', baseUrl: 'https://corpus.example.com', enabled: true }
          }
        }
      })
    )
    const sparse = stripDefaults(patched, defaultSettings(), {
      atomicPaths: SETTINGS_ATOMIC_PATHS
    }) as Record<string, unknown>
    expect(settingsSchema.parse(sparse)).toEqual(patched)
    // the kept entry is verbatim — all three required fields survive
    const defectCorpus = sparse.defectCorpus as Record<string, unknown>
    const sources = defectCorpus.sources as Record<string, Record<string, unknown>>
    expect(sources.src1).toEqual({
      name: 'Hindsight',
      baseUrl: 'https://corpus.example.com',
      enabled: true
    })
  })

  it('an rca.template edit survives stripDefaults + re-parse with both report lists intact', () => {
    // The hazard: `rca.template.exec`/`tech` are REQUIRED with no schema default, so if
    // stripDefaults recursed and dropped whichever list still equals the default, the file on
    // disk would fail `settingsSchema.safeParse` on next launch and SettingsService.loadNow
    // would fall back to defaults for the WHOLE file — losing every unrelated setting.
    const patched = defaultSettings()
    patched.rca.template.exec[0].heading = 'What went wrong'

    const sparse = stripDefaults(patched, defaultSettings(), { atomicPaths: SETTINGS_ATOMIC_PATHS })
    const reparsed = settingsSchema.safeParse(sparse)
    expect(reparsed.success).toBe(true)
    if (!reparsed.success) return

    // the edit survived...
    expect(reparsed.data.rca.template.exec[0].heading).toBe('What went wrong')
    // ...and the untouched list came back whole, not missing
    expect(reparsed.data.rca.template.tech).toEqual(defaultSettings().rca.template.tech)
    expect(reparsed.data.rca.template.exec.length).toBe(defaultSettings().rca.template.exec.length)
    // and nothing unrelated was lost by the fallback path
    expect(reparsed.data).toEqual(patched)
  })

  it('rejects a section id reused across the two report lists', () => {
    // The model returns ONE flat `sections` record keyed by id and `narrativeBody` resolves from
    // the id alone, so a duplicate makes the same body serve both reports — and since the tech
    // instructions invite evidence paths, that is a direct route for technical prose into the
    // non-technical exec Jira comment. The UI cannot mint a duplicate, but settings.json is
    // hand-editable and the schema is the documented enforcement point.
    const t = defaultSettings()
    t.rca.template.tech.push({
      id: 'exec-impact',
      heading: 'Impact',
      kind: 'narrative',
      enabled: true,
      instruction: 'Anything.'
    })
    const res = settingsSchema.safeParse(t)
    expect(res.success).toBe(false)
    if (res.success) return
    expect(res.error.issues.some((i) => /exec-impact/.test(i.message))).toBe(true)
  })

  it('accepts the shipped default template, whose ids are all distinct', () => {
    expect(settingsSchema.safeParse(defaultSettings()).success).toBe(true)
  })

  it('ui.knowledgeStripDismissed defaults false and survives strip + re-parse when set', () => {
    expect(defaultSettings().ui.knowledgeStripDismissed).toBe(false)
    const set = settingsSchema.parse({ ui: { knowledgeStripDismissed: true } })
    expect(set.ui.knowledgeStripDismissed).toBe(true)
    const stripped = stripDefaults(set, defaultSettings())
    expect(stripped).toEqual({ ui: { knowledgeStripDismissed: true } })
    expect(settingsSchema.parse(stripped).ui.knowledgeStripDismissed).toBe(true)
  })

  it('defaults both keep-alive keys off', () => {
    const s = settingsSchema.parse({})
    expect(s.general.keepAliveInBackground).toBe(false)
    expect(s.general.keepAliveNoticeShown).toBe(false)
  })

  it('round-trips keep-alive on', () => {
    const s = settingsSchema.parse({ general: { keepAliveInBackground: true } })
    expect(s.general.keepAliveInBackground).toBe(true)
    // Untouched siblings keep their own defaults rather than being wiped by the partial parse.
    expect(s.general.confirmCaseDelete).toBe(true)
  })

  it('accepts "auto" as agent.defaultPermissionMode', () => {
    const s = settingsSchema.parse({ agent: { defaultPermissionMode: 'auto' } })
    expect(s.agent.defaultPermissionMode).toBe('auto')
  })

  it('MODE_BY_LABEL round-trips the auto label back to the auto mode', () => {
    expect(PERMISSION_MODE_LABELS.auto).toBe('Auto — Claude decides')
    expect(MODE_BY_LABEL['Auto — Claude decides']).toBe('auto')
  })

  it('BASE_PERMISSION_MODES excludes auto and is otherwise identical to PERMISSION_MODES', () => {
    expect(BASE_PERMISSION_MODES).not.toContain('auto')
    expect(PERMISSION_MODES).toContain('auto')
    expect(BASE_PERMISSION_MODES).toEqual(PERMISSION_MODES.filter((m) => m !== 'auto'))
  })

  // Task 6 Critical: watermark.jira / watermark.github leaves had no leaf `.default()`, only
  // the parent object did (fires only when the whole key is absent). A partial target — the
  // normal shape after stripDefaults strips ONE customized leaf back to disk — failed re-parse
  // entirely, which in production discarded unrelated settings on the next `patch()`. See
  // DEFAULT_WATERMARK_TEXT / watermarkSchema in settings.ts for the fix.
  it('fills a missing leaf on a partial watermark target instead of failing to parse', () => {
    const jiraPartial = settingsSchema.parse({ watermark: { jira: { text: 'x' } } })
    expect(jiraPartial.watermark.jira).toEqual({ enabled: true, text: 'x' })

    const githubPartial = settingsSchema.parse({ watermark: { github: { enabled: true } } })
    expect(githubPartial.watermark.github).toEqual({
      enabled: true,
      text: DEFAULT_WATERMARK_TEXT
    })
  })

  it('round-trips a single customized watermark leaf through stripDefaults + parse', () => {
    const patched = settingsSchema.parse(
      deepMerge(defaultSettings(), { watermark: { jira: { text: 'Custom footer' } } })
    )
    const sparse = stripDefaults(patched, defaultSettings()) as Record<string, unknown>
    // Only the customized leaf survives — this is exactly the partial-target shape that used to
    // fail re-parse (the other target isn't even present as a key).
    expect(sparse).toEqual({ watermark: { jira: { text: 'Custom footer' } } })
    expect(settingsSchema.parse(sparse)).toEqual(patched)
  })

  it('re-seeds the default watermark text when the reset patch deletes the leaf', () => {
    const patched = settingsSchema.parse(
      deepMerge(defaultSettings(), { watermark: { jira: { text: 'Custom footer' } } })
    )
    // Mirrors ConnectorsSettings.tsx's reset idiom: patch with `{ text: null }` to delete the key.
    const reset = deepMerge(patched, { watermark: { jira: { text: null } } })
    // Must not throw — the pre-fix schema (no leaf default) rejected `enabled` alone as a target.
    const reparsed = settingsSchema.parse(reset)
    expect(reparsed.watermark.jira).toEqual({ enabled: true, text: DEFAULT_WATERMARK_TEXT })
  })
})
