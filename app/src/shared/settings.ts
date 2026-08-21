import { z } from './zodConfig'
import { defectCorpusSchema } from './defectCorpus'
import { DEFAULT_RCA_TEMPLATE, type RcaTemplate } from './rcaTemplate'
import { UPDATE_CHANNELS } from './updates'

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'auto'
] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** `PERMISSION_MODES` minus `auto`, derived (not hand-written) so the two cannot drift. */
export const BASE_PERMISSION_MODES = PERMISSION_MODES.filter(
  (m): m is Exclude<PermissionMode, 'auto'> => m !== 'auto'
)

/** Labels used by the Composer's permission chip and the Agent settings select. */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Ask approvals',
  acceptEdits: 'Auto-approve edits',
  plan: 'Plan mode',
  bypassPermissions: 'Bypass approvals',
  auto: 'Auto — Claude decides'
}

/** Inverse of `PERMISSION_MODE_LABELS` — used to resolve a picker's chosen label back to
 *  the mode it names. Shared by the Composer's permission chip/collapsed menu and the
 *  Agent settings select so all three can't drift apart. */
export const MODE_BY_LABEL: Record<string, PermissionMode> = Object.fromEntries(
  Object.entries(PERMISSION_MODE_LABELS).map(([mode, label]) => [label, mode as PermissionMode])
) as Record<string, PermissionMode>

const providerInstanceSchema = z.looseObject({
  driver: z.string(), // OPEN slug — unknown drivers must round-trip
  displayName: z.string().optional(),
  enabled: z.boolean().default(true),
  config: z.unknown().optional() // opaque envelope; validated by the driver's own schema
})
export type ProviderInstance = z.infer<typeof providerInstanceSchema>

const generalSchema = z.looseObject({
  /** @deprecated Case deletion always confirms (user-directed, 2026-08-21) — a switch whose
   *  only non-default state disables an irreversible action's guard. Kept in the schema for
   *  one release so an existing `false` on disk parses instead of failing the whole settings
   *  read; nothing reads it. `looseObject` would tolerate the key regardless, but naming it
   *  here is what stops someone reintroducing it as a live setting. */
  confirmCaseDelete: z.boolean().default(true),
  /** @deprecated Superseded by `defaultRepos`. Retained only so the one-time
   *  `migrateDefaultRepoToList` can read it; that migration nulls it, after which
   *  `stripDefaults` drops the key from disk entirely (null IS its default). Do not
   *  read this anywhere else — `defaultRepos` is the only live source of defaults. */
  defaultRepo: z.string().nullable().default(null),
  /** Repos auto-linked to every new case. Empty equals its default, so an emptied list is
   *  stripped from disk and reseeds as `[]` on reload — which is the correct end state. */
  defaultRepos: z.array(z.string()).default([]),
  /** @deprecated Renamed to `relatedIncludeLocalCases` and moved to Settings → Defect corpus
   *  (user-directed, 2026-08-21). `migrateRelatedSearchSwitches` copies a stored `true` across
   *  and nulls this key; do not read it anywhere else. */
  similarPastCasesEnabled: z.boolean().default(false),
  /**
   * Whether opening a case runs a related-history search at all — local cases AND every enabled
   * defect corpus. Its predecessor (`similarPastCasesEnabled`) gated only the local provider,
   * which left no way to stop the case-open fan-out as a whole.
   *
   * On by default, because that is exactly what today's build does: corpus providers already
   * search on every case open, and an upgrade must not silently stop them. Off means nothing is
   * searched until the user opens the related-history explorer themselves — the explorer is
   * user-initiated and is deliberately NOT gated by this.
   */
  relatedSearchOnOpen: z.boolean().default(true),
  /** Whether this install's own closed cases are one of the sources that search draws on. Off
   *  by default, unchanged from `similarPastCasesEnabled` — the local provider only has
   *  anything to match against once cases have been distilled. Gates
   *  RelatedHistoryService's local provider; corpus providers and the `search_case_history`
   *  agent tool are unaffected (design decision, 2026-08-05 spec). */
  relatedIncludeLocalCases: z.boolean().default(false),
  /** Closing the last window leaves Argus in the tray instead of quitting, so scheduled
   *  routines keep firing. Off by default: a fresh install must not leave a background process
   *  behind for a user who has never created a routine. With it off nothing is lost, only
   *  delayed — increment 2's catch-up fires an overdue routine once on the next launch.
   *  No effect on macOS, which never quit on last-window-close to begin with (see
   *  services/keepAlive.ts). */
  keepAliveInBackground: z.boolean().default(false),
  /** Set once, the first time keep-alive swallows a window close, so the "Argus is still
   *  running" notice shows exactly once per install. Deliberately not surfaced in the Settings
   *  UI — it is a seen-marker, not a preference. */
  keepAliveNoticeShown: z.boolean().default(false)
})

/** Per-instance model list customization (favorite/hide/reorder). All three lists default empty. */
const modelPreferencesSchema = z.looseObject({
  hiddenModels: z.array(z.string()).default([]),
  favoriteModels: z.array(z.string()).default([]),
  modelOrder: z.array(z.string()).default([])
})
export type ModelPreferences = z.infer<typeof modelPreferencesSchema>

/** Provider instance used for headless one-shot distillation (case close, reference sync).
 *  Absent = resolve the first enabled claude-agent-sdk instance. Deliberately NOT the active
 *  chat instance: activeInstanceId is a chat default, not a commitment to a driver kind. */
const distillProviderSchema = z.looseObject({
  instanceId: z.string(),
  model: z.string().optional()
})

const agentSchema = z.looseObject({
  activeInstanceId: z.string().default('claude-default'),
  maxSessions: z.number().int().min(1).max(16).default(3),
  probeTimeoutMs: z.number().int().min(1000).max(120000).default(10000),
  defaultPermissionMode: z.enum(PERMISSION_MODES).default('default'),
  personaAppend: z.string().default(''),
  providerInstances: z.record(z.string(), providerInstanceSchema).default(() => ({
    'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} }
  })),
  /** Keyed by provider instance id. An entry whose lists are all empty is equivalent to absent. */
  modelPreferences: z.record(z.string(), modelPreferencesSchema).default(() => ({})),
  distillProvider: distillProviderSchema.optional()
})

const toolsSchema = z.looseObject({
  traceDir: z.string().default(''), // '' = auto-resolve
  parseBin: z.string().default('') // '' = auto-resolve
})

/** One section of a report template. `superRefine` enforces the kind/field pairing the
 *  renderer relies on: a claims section without a slot has nothing to render, and a narrative
 *  section without an instruction gives the model (increment 2) nothing to write. */
const rcaSectionSchema = z
  .object({
    id: z.string().min(1),
    heading: z.string(),
    kind: z.enum(['claims', 'narrative']),
    slot: z
      .enum([
        'root-cause',
        'contributing',
        'symptoms',
        'ruled-out',
        'timeline',
        'remediation',
        'tech-narrative'
      ])
      .optional(),
    instruction: z.string().optional(),
    enabled: z.boolean().default(true)
  })
  .superRefine((s, ctx) => {
    if (s.kind === 'claims' && !s.slot)
      ctx.addIssue({
        code: 'custom',
        message: `RCA section "${s.id}" is claims-kind but has no slot`
      })
    if (s.kind === 'narrative' && s.slot)
      ctx.addIssue({
        code: 'custom',
        message: `RCA section "${s.id}" is narrative-kind but has a slot`
      })
    if (s.kind === 'narrative' && !s.instruction?.trim())
      ctx.addIssue({
        code: 'custom',
        message: `RCA section "${s.id}" is narrative-kind but has no instruction`
      })
  })

/** Where a confirmed RCA report's technical drill-down is posted (`main/services/rca/post.ts`).
 *  The exec summary always goes as a Jira comment; this only controls the tech artifact's home. */
const rcaSchema = z.looseObject({
  techDestination: z.enum(['attachment', 'confluence-page']).default('attachment'),
  /** A Confluence *space key* (e.g. "ENG"), despite feeding the `createConfluencePage` tool's
   *  `spaceId` argument — that tool resolves a key to its numeric space id automatically. */
  confluenceSpaceKey: z.string().default(''),
  /** Ordered section lists per report. A settings file written before templates existed gets
   *  `DEFAULT_RCA_TEMPLATE`, which renders byte-identically to the pre-template output. */
  template: z
    .object({
      exec: z.array(rcaSectionSchema),
      tech: z.array(rcaSectionSchema)
    })
    /** The exec report is narrative-only by contract: it goes to a non-technical audience as a
     *  Jira comment and may never show citations, finding ids, or file paths, which is exactly
     *  what a `claims` section renders. `renderExecReport` therefore does not branch on `kind`,
     *  so a claims row in the exec list would silently render the wrong body. Refuse it here —
     *  the tech list still accepts both kinds. */
    .superRefine((t, ctx) => {
      for (const s of t.exec) {
        if (s.kind === 'claims')
          ctx.addIssue({
            code: 'custom',
            path: ['exec'],
            message: `RCA section "${s.id}" is claims-kind and cannot go in the exec report, which never shows citations, finding ids, or file paths`
          })
      }
      // Ids are one flat namespace across BOTH lists: the model returns a single `sections`
      // record keyed by id and `narrativeBody` resolves from the id alone, so a duplicate makes
      // one body serve both reports — which, since tech instructions invite evidence paths, puts
      // technical prose in the non-technical exec comment. The UI cannot mint a duplicate, but
      // settings.json is hand-editable and this schema is the documented enforcement point.
      const seen = new Set<string>()
      for (const s of [...t.exec, ...t.tech]) {
        if (seen.has(s.id))
          ctx.addIssue({
            code: 'custom',
            path: ['tech'],
            message: `RCA section id "${s.id}" is used twice; ids must be unique across both reports because the model returns one flat sections map keyed by id`
          })
        seen.add(s.id)
      }
    })
    .default(() => structuredClone(DEFAULT_RCA_TEMPLATE) as RcaTemplate)
})

/** The default footer for both destinations. The "reviewed before posting" clause is true
 *  whenever the approval card is in play — the normal path for both seams — and overclaims
 *  for an unattended/bypass run, which the settings UI says out loud. It stays in the
 *  default rather than being weakened because the field is free text. */
export const DEFAULT_WATERMARK_TEXT = '_AI-assisted — drafted by Argus, reviewed before posting._'

const JIRA_WATERMARK = { enabled: true, text: DEFAULT_WATERMARK_TEXT }
const GITHUB_WATERMARK = { enabled: false, text: DEFAULT_WATERMARK_TEXT }

/**
 * A Markdown footer appended to comments ARGUS composes (`rca/post.ts`,
 * `agent/reviewWrites.ts`). Deliberately not applied to comments the model posts itself
 * through the Rovo MCP connector — that body never passes through our code — nor to the RCA
 * Confluence page or attachment, which are documents rather than comments.
 *
 * Jira defaults ON: a Jira comment reads as a human ticket update, so disclosure matters
 * most there. GitHub defaults OFF so upgrading never silently changes what lands on a PR.
 *
 * Leaf `.default()`s are load-bearing, not decorative: `stripDefaults` recurses into
 * `watermark.jira`/`watermark.github` (they are not in `SETTINGS_ATOMIC_PATHS`), so a single
 * customized leaf is written to disk as a PARTIAL target — `{ text: '...' }` with no `enabled`.
 * Without a default on `enabled` here, re-parsing that partial target on the next launch throws,
 * which upstream falls back to `defaultSettings()` and then rewrites settings.json from
 * scratch on the next `patch()` — silently discarding unrelated settings. A parent-level
 * `.default()` alone (the previous shape) only fires when the whole key is absent; it does not
 * help a partial target. Do NOT "fix" this by adding these paths to `SETTINGS_ATOMIC_PATHS`
 * instead — that would round-trip the disk write but leave the reset-button idiom
 * (`{ text: null }` → `deepMerge` deletes the key → re-parse) throwing instead of re-seeding.
 */
const watermarkSchema = z.looseObject({
  jira: z
    .looseObject({
      enabled: z.boolean().default(JIRA_WATERMARK.enabled),
      text: z.string().default(JIRA_WATERMARK.text)
    })
    .default(() => ({ ...JIRA_WATERMARK })),
  github: z
    .looseObject({
      enabled: z.boolean().default(GITHUB_WATERMARK.enabled),
      text: z.string().default(GITHUB_WATERMARK.text)
    })
    .default(() => ({ ...GITHUB_WATERMARK }))
})

const hivemindSchema = z.looseObject({
  /** GitHub 'org/name' of the shared HiveMind repo; '' keeps HiveMind features dormant. */
  repo: z.string().default('')
})

const observabilitySchema = z.looseObject({
  langfuse: z
    .looseObject({
      enabled: z.boolean().default(false),
      host: z.string().default(''),
      publicKey: z.string().default(''),
      captureContent: z.boolean().default(false)
    })
    .default(() => ({ enabled: false, host: '', publicKey: '', captureContent: false })),
  dashboard: z
    .looseObject({ hiddenCards: z.array(z.string()).default([]) })
    .default(() => ({ hiddenCards: [] }))
})

const memoryHygieneSchema = z.looseObject({
  /** A memory topic is a stale candidate after this many days without recall or write. */
  staleDays: z.number().int().min(1).default(45),
  /** ...and only when it has fewer than this many recalls since tracking began. */
  minRecalls: z.number().int().min(1).default(3),
  /** Stamped once at first startup after the usage-stats feature ships (grace-period anchor). */
  trackingStartedAt: z.string().default('')
})

/**
 * Stamps for one-time settings upgrades (`main/services/settingsMigrations.ts`). Each key is
 * an ISO timestamp, `''` meaning "has not run". They live in their own section rather than
 * beside the setting they fix, so a migration is never confused for a user preference and so
 * `stripDefaults` keeps them (a stamp always differs from its `''` default once written).
 */
const migrationsSchema = z.looseObject({
  /** When the stored `agent.defaultPermissionMode` of `bypassPermissions` was reset, after
   *  that mode stopped being inert. Presence — not the mode's value — is what makes the
   *  reset run exactly once, so a Bypass chosen deliberately afterwards survives. */
  bypassDefaultReset: z.string().default(''),
  /** When `general.defaultRepo` (single) was folded into `general.defaultRepos` (list). */
  defaultRepoToList: z.string().default(''),
  /** When `general.similarPastCasesEnabled` was split into `relatedSearchOnOpen` (new master)
   *  and `relatedIncludeLocalCases` (the old meaning). */
  relatedSearchSwitches: z.string().default('')
})

/** Jira's own built-in clone link type. Exported so the REST client's fallback and the schema
 *  default are one value rather than two strings drifting apart. */
export const DEFAULT_CLONE_LINK_TYPES = ['Cloners'] as const

const jiraSchema = z.looseObject({
  /** Jira link-type names treated as "this ticket is a clone of that one". Compared
   *  case-insensitively. Default is Jira's built-in type; an org that renamed it, or uses a
   *  custom type, adds theirs here.
   *
   *  A stored `[]` genuinely means "match nothing" — unlike an emptied RECORD, an empty array
   *  does not equal this non-empty default, so `stripDefaults` keeps it and it survives a
   *  reload. That is why the settings UI patches `null` (the repo's reset idiom: deepMerge
   *  deletes the key, re-parse re-seeds) when the last entry is removed, rather than `[]`. */
  cloneLinkTypes: z.array(z.string()).default([...DEFAULT_CLONE_LINK_TYPES])
})

const uiSchema = z.looseObject({
  /** "How knowledge flows" strip on the Library/Proposals pages — once dismissed it never returns. */
  knowledgeStripDismissed: z.boolean().default(false)
})

/** Free-text operator guidance folded into every case distillation's input (v2 and v3) — a
 *  standing steer ("prefer recipes over new skills", "watch for X") rather than a per-run
 *  instruction. */
const distillSchema = z.looseObject({
  guidance: z.string().default(''),
  /** Which case-distill pipeline runs: 'v2' = single agentic call; 'v3' = staged pipeline.
   *  Defaults to 'v2' — v3 stays opt-in until it has run against real cases. Read at job-run
   *  time (and at enqueue time for `prompt_hash`), so flipping it takes effect on the next job
   *  with no restart. */
  pipeline: z.enum(['v2', 'v3']).default('v2')
})

const onboardingSchema = z.looseObject({
  /** ISO time onboarding finished/was dismissed; null = never → treat as first-run. */
  completedAt: z.string().nullable().default(null),
  phase1Done: z.boolean().default(false),
  tourDone: z.boolean().default(false),
  /** Slug of the seeded sample case; null until seeded. */
  sampleCaseSlug: z.string().nullable().default(null),
  /** Which integrations were configured during setup (drives Phase-2 live vs explain). */
  integrations: z
    .looseObject({
      jira: z.boolean().default(false),
      confluence: z.boolean().default(false),
      hive: z.boolean().default(false)
    })
    .default(() => ({ jira: false, confluence: false, hive: false }))
})

/** Which release track this install follows. One leaf, carrying its own `.default()`, so the
 *  section needs no `SETTINGS_ATOMIC_PATHS` entry: `stripDefaults` can only ever reduce it to
 *  `{}`, which re-parses back to the default rather than throwing. */
const updatesSchema = z.looseObject({
  channel: z.enum(UPDATE_CHANNELS).default('stable')
})

export const settingsSchema = z.looseObject({
  general: generalSchema.default(() => generalSchema.parse({})),
  agent: agentSchema.default(() => agentSchema.parse({})),
  tools: toolsSchema.default(() => toolsSchema.parse({})),
  rca: rcaSchema.default(() => rcaSchema.parse({})),
  watermark: watermarkSchema.default(() => watermarkSchema.parse({})),
  hivemind: hivemindSchema.default(() => hivemindSchema.parse({})),
  defectCorpus: defectCorpusSchema.default(() => defectCorpusSchema.parse({})),
  observability: observabilitySchema.default(() => observabilitySchema.parse({})),
  onboarding: onboardingSchema.default(() => onboardingSchema.parse({})),
  memoryHygiene: memoryHygieneSchema.default(() => memoryHygieneSchema.parse({})),
  jira: jiraSchema.default(() => jiraSchema.parse({})),
  ui: uiSchema.default(() => uiSchema.parse({})),
  migrations: migrationsSchema.default(() => migrationsSchema.parse({})),
  distill: distillSchema.default(() => distillSchema.parse({})),
  updates: updatesSchema.default(() => updatesSchema.parse({}))
})

export type AppSettings = z.infer<typeof settingsSchema>
export type AgentSettings = AppSettings['agent']

export function defaultSettings(): AppSettings {
  return settingsSchema.parse({})
}

/** Patch type: any leaf may be its value or null (null deletes the key → default refills).
 *
 *  `NonNullable` is load-bearing: an OPTIONAL object property has type `{...} | undefined`,
 *  and a union with undefined does not satisfy `extends Record<string, unknown>`. Without it
 *  such a property never recursed, so a nested null — this codebase's delete idiom — was
 *  inexpressible for it. Stripping undefined before the test is purely widening: required
 *  object properties, arrays (no string index signature) and scalar leaves are unaffected.
 *
 *  Note the widening reaches nested REQUIRED keys too, so `{a:{b:null}}` type-checks even
 *  when `b` is required and `parse` would then reject it. That hazard is inherent to a
 *  null-deletes patch type — it already applied to `providerInstances.<id>.driver`, which is
 *  why `SETTINGS_ATOMIC_PATHS` exists — and is not introduced by this change. */
export type DeepPatch<T> = {
  [K in keyof T]?:
    | (unknown extends T[K]
        ? T[K] // zod looseObject index signatures are `unknown` — leave them permissive
        : NonNullable<T[K]> extends Record<string, unknown>
          ? DeepPatch<NonNullable<T[K]>>
          : T[K])
    | null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Non-mutating deep merge. Objects merge; scalars/arrays replace; null deletes the key. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch == null ? base : patch
  if (!isPlainObject(base)) return patch
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v)
    else out[k] = v
  }
  return out
}

function deepEqual(a: unknown, b: unknown): boolean {
  // Identical primitives via Object.is
  if (Object.is(a, b)) return true

  // Arrays: same length, elements deepEqual in order
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }

  // Plain objects: same key set (regardless of order), values deepEqual
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort()
    const bKeys = Object.keys(b).sort()
    if (aKeys.length !== bKeys.length) return false
    if (!aKeys.every((k, i) => k === bKeys[i])) return false
    return aKeys.every((k) => deepEqual(a[k], b[k]))
  }

  return false
}

/**
 * Object paths (dotted, from the settings root) whose entries must be
 * stripped/kept ATOMICALLY rather than recursed into leaf-by-leaf. Used for
 * maps like `agent.providerInstances` where a sparse partial entry (e.g. only
 * `config` surviving because `driver`/`enabled` equal the schema defaults)
 * would fail re-validation on reload (`driver` is required).
 */
export const SETTINGS_ATOMIC_PATHS: readonly string[] = [
  'agent.providerInstances',
  'defectCorpus.sources',
  /** Listed as the PARENT `rca`, not `rca.template`: a path here makes that object's own
   *  ENTRIES atomic, so `'rca.template'` would still compare `exec`/`tech` separately and drop
   *  whichever list still equals the default. `template.exec`/`.tech` are required with no
   *  schema default, so a file missing either one fails `settingsSchema.safeParse` on the next
   *  launch and `SettingsService.loadNow` falls back to defaults for the WHOLE file. Listing
   *  `rca` keeps `template` whole-or-absent; `rca`'s other keys are scalars, for which atomic
   *  and leaf-by-leaf comparison are identical. */
  'rca'
]

function stripDefaultsAt(
  value: unknown,
  defaults: unknown,
  atomicPaths: readonly string[],
  currentPath: string
): unknown {
  if (!isPlainObject(value) || !isPlainObject(defaults)) return value
  const out: Record<string, unknown> = {}
  const atomicHere = atomicPaths.includes(currentPath)
  for (const [k, v] of Object.entries(value)) {
    if (!(k in defaults)) {
      out[k] = v // unknown key — preserve verbatim
      continue
    }
    if (atomicHere) {
      if (!deepEqual(v, defaults[k])) out[k] = v // whole entry kept verbatim, or dropped
      continue
    }
    const childPath = currentPath ? `${currentPath}.${k}` : k
    if (isPlainObject(v) && isPlainObject(defaults[k])) {
      const sub = stripDefaultsAt(v, defaults[k], atomicPaths, childPath)
      if (isPlainObject(sub) && Object.keys(sub).length > 0) out[k] = sub
    } else if (!deepEqual(v, defaults[k])) {
      out[k] = v
    }
  }
  return out
}

/**
 * Remove every leaf equal to its default (deep); unknown keys are always
 * kept. Pass `atomicPaths` (dotted, from the root) to compare an object's
 * entries as whole units instead of recursing into them — see
 * `SETTINGS_ATOMIC_PATHS`.
 */
export function stripDefaults(
  value: unknown,
  defaults: unknown,
  opts?: { atomicPaths?: readonly string[] }
): unknown {
  return stripDefaultsAt(value, defaults, opts?.atomicPaths ?? [], '')
}

// --- IPC payload shapes -----------------------------------------------------

export interface ResolvedToolRow {
  id: string
  /** id of the pack whose manifest declared this binary. */
  packId: string
  displayName: string
  description: string
  kind: 'exe' | 'pathDir'
  envVar: string | null
  settingsKey: string | null
  /** Current settings.tools[settingsKey] ('' when unset). */
  settingsValue: string
  value: string | null
  source: 'env' | 'settings' | 'default'
}

export interface ProbeToolRow {
  id: string
  ok: boolean
  /** Short badge text: 'found · <version>' | 'found' | 'not found'. */
  chip: string
  /** Long text (health): resolved path · version. */
  detail: string
}

export interface SettingsPayload {
  settings: AppSettings
  resolvedTools: ResolvedToolRow[]
  dataRoot: { path: string; fromEnv: boolean }
  loadError: string | null
  /** Dev-tools gate (`main/services/prompts/gate.ts`). Optional so the 34 inline payload
   *  fixtures in tests keep compiling; absent means OFF, which is the fail-safe default. */
  devTools?: boolean
}
