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
  confirmCaseDelete: z.boolean().default(true)
})

const agentSchema = z.looseObject({
  activeInstanceId: z.string().default('claude-default'),
  maxSessions: z.number().int().min(1).max(16).default(3),
  probeTimeoutMs: z.number().int().min(1000).max(120000).default(10000),
  defaultPermissionMode: z.enum(PERMISSION_MODES).default('default'),
  personaAppend: z.string().default(''),
  providerInstances: z.record(z.string(), providerInstanceSchema).default(() => ({
    'claude-default': { driver: 'claude-agent-sdk', enabled: true, config: {} }
  }))
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
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v)
    else out[k] = v
  }
  return out
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Remove every leaf equal to its default (deep); unknown keys are always kept. */
export function stripDefaults(value: unknown, defaults: unknown): unknown {
  if (!isPlainObject(value) || !isPlainObject(defaults)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (!(k in defaults)) {
      out[k] = v // unknown key — preserve verbatim
    } else if (isPlainObject(v) && isPlainObject(defaults[k])) {
      const sub = stripDefaults(v, defaults[k])
      if (isPlainObject(sub) && Object.keys(sub).length > 0) out[k] = sub
    } else if (!deepEqual(v, defaults[k])) {
      out[k] = v
    }
  }
  return out
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
