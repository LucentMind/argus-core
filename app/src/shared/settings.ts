import { z } from 'zod'

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** Labels used by the Composer's permission chip and the Agent settings select. */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Ask approvals',
  acceptEdits: 'Auto-approve edits',
  plan: 'Plan mode',
  bypassPermissions: 'Bypass approvals'
}

export const TIMESTAMP_FORMATS = ['locale', '12h', '24h'] as const
export type TimestampFormat = (typeof TIMESTAMP_FORMATS)[number]

const providerInstanceSchema = z.looseObject({
  driver: z.string(), // OPEN slug — unknown drivers must round-trip
  displayName: z.string().optional(),
  enabled: z.boolean().default(true),
  config: z.unknown().optional() // opaque envelope; validated by the driver's own schema
})
export type ProviderInstance = z.infer<typeof providerInstanceSchema>

const generalSchema = z.looseObject({
  timestampFormat: z.enum(TIMESTAMP_FORMATS).default('locale'),
  confirmCaseDelete: z.boolean().default(true),
  defaultRepo: z.string().nullable().default(null)
})

/** Per-instance model list customization (favorite/hide/reorder). All three lists default empty. */
const modelPreferencesSchema = z.looseObject({
  hiddenModels: z.array(z.string()).default([]),
  favoriteModels: z.array(z.string()).default([]),
  modelOrder: z.array(z.string()).default([])
})
export type ModelPreferences = z.infer<typeof modelPreferencesSchema>

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
  modelPreferences: z.record(z.string(), modelPreferencesSchema).default(() => ({}))
})

const toolsSchema = z.looseObject({
  traceDir: z.string().default(''), // '' = auto-resolve
  parseBin: z.string().default('') // '' = auto-resolve
})

export const settingsSchema = z.looseObject({
  general: generalSchema.default(() => generalSchema.parse({})),
  agent: agentSchema.default(() => agentSchema.parse({})),
  tools: toolsSchema.default(() => toolsSchema.parse({}))
})

export type AppSettings = z.infer<typeof settingsSchema>
export type AgentSettings = AppSettings['agent']

export function defaultSettings(): AppSettings {
  return settingsSchema.parse({})
}

/** Patch type: any leaf may be its value or null (null deletes the key → default refills). */
export type DeepPatch<T> = {
  [K in keyof T]?: (T[K] extends Record<string, unknown> ? DeepPatch<T[K]> : T[K]) | null
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
export const SETTINGS_ATOMIC_PATHS: readonly string[] = ['agent.providerInstances']

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

export interface ResolvedTool {
  value: string | null
  source: 'env' | 'settings' | 'default'
}

export interface ProbeToolsReport {
  parseBin: { path: string | null; version: string | null }
  traceDir: { path: string | null; found: boolean }
}

export interface SettingsPayload {
  settings: AppSettings
  resolvedTools: { traceDir: ResolvedTool; parseBin: ResolvedTool }
  dataRoot: { path: string; fromEnv: boolean }
  loadError: string | null
}
