import { z } from 'zod'
import type { AppSettings, ModelPreferences } from './settings'

export interface FieldAnnotation {
  control: 'text' | 'password' | 'textarea' | 'select' | 'switch' | 'number'
  label: string
  placeholder?: string
  options?: readonly string[]
  order: number
  /** RESERVED — no driver field may set this until the keychain secret store lands (Wave 2 Part 2). */
  sensitive?: boolean
  /** Value treated as "default" by the reset affordance (besides null/''). */
  defaultValue?: unknown
}

export interface CatalogModel {
  slug: string
  name: string
  isCustom?: boolean
}

export interface DriverDefinition {
  kind: string
  label: string
  /** Short display form for compact UI (e.g. the settings provider-card header). Falls back to `label`. */
  shortLabel?: string
  configSchema: z.ZodType
  formAnnotations: Record<string, FieldAnnotation>
  models: readonly CatalogModel[]
}

const claudeConfigSchema = z.looseObject({
  model: z.string().optional(), // back-compat: hand-edited config.model still wins (see effectiveDefaultModel)
  cliPath: z.string().optional(),
  customModels: z.array(z.string()).optional()
})
export type ClaudeDriverConfig = z.infer<typeof claudeConfigSchema>

/** Static built-in catalog (t3code BUILT_IN_MODELS) — unconditional, not user-editable. */
const CLAUDE_MODELS: readonly CatalogModel[] = [
  { slug: 'claude-fable-5', name: 'Claude Fable 5' },
  { slug: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { slug: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  { slug: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { slug: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { slug: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }
]

export const DRIVERS: Record<string, DriverDefinition> = {
  'claude-agent-sdk': {
    kind: 'claude-agent-sdk',
    label: 'Claude Agent SDK',
    shortLabel: 'Claude',
    configSchema: claudeConfigSchema,
    // model is rendered by the dedicated Models section (ProviderModels), not the generic form
    formAnnotations: {
      cliPath: { control: 'text', label: 'Claude CLI path', placeholder: 'auto-detect', order: 2 }
    },
    models: CLAUDE_MODELS
  }
}

export function getDriver(slug: string): DriverDefinition | null {
  return DRIVERS[slug] ?? null
}

/** Validate an opaque instance config against its driver's schema; {} on unknown driver or invalid config. */
export function driverConfig<T>(slug: string, raw: unknown): T {
  const d = getDriver(slug)
  if (!d) return {} as T
  const r = d.configSchema.safeParse(raw ?? {})
  return (r.success ? r.data : {}) as T
}

/** Config of the active, enabled provider instance ({} if missing/disabled/unknown driver). */
export function activeInstanceConfig(s: AppSettings): ClaudeDriverConfig {
  const a = s.agent
  const inst = a.providerInstances[a.activeInstanceId]
  if (!inst || !inst.enabled) return {}
  return driverConfig<ClaudeDriverConfig>(inst.driver, inst.config)
}

const EMPTY_PREFS: ModelPreferences = {
  hiddenModels: [],
  favoriteModels: [],
  modelOrder: []
}

/** The driver's static catalog plus that instance's hand-added custom models (deduped, flagged). */
export function instanceModels(s: AppSettings, instanceId?: string): CatalogModel[] {
  const id = instanceId ?? s.agent.activeInstanceId
  const inst = s.agent.providerInstances[id]
  if (!inst || !inst.enabled) return [] // same gate as activeInstanceConfig
  const driver = getDriver(inst.driver)
  const catalog = driver?.models ?? []
  const cfg = driverConfig<Record<string, unknown>>(inst.driver, inst.config)
  const rawCustom = Array.isArray(cfg.customModels) ? cfg.customModels : []
  const catalogSlugs = new Set(catalog.map((m) => m.slug))
  const seen = new Set<string>()
  const customs: CatalogModel[] = []
  for (const slug of rawCustom) {
    if (typeof slug !== 'string' || catalogSlugs.has(slug) || seen.has(slug)) continue
    seen.add(slug)
    customs.push({ slug, name: slug, isCustom: true })
  }
  return [...catalog, ...customs]
}

/**
 * t3code `sortModelsForProviderInstance` ordering, ported as plain TS (no effect library):
 * favorites grouped first, then explicit modelOrder rank, then original catalog order — all stable.
 */
function sortModels(models: readonly CatalogModel[], prefs: ModelPreferences): CatalogModel[] {
  const orderRank = new Map(prefs.modelOrder.map((slug, i) => [slug, i]))
  const originalRank = new Map(models.map((m, i) => [m.slug, i]))
  const favorites = new Set(prefs.favoriteModels)
  return [...models].sort((a, b) => {
    const favA = favorites.has(a.slug) ? 0 : 1
    const favB = favorites.has(b.slug) ? 0 : 1
    if (favA !== favB) return favA - favB
    const oa = orderRank.get(a.slug) ?? Number.POSITIVE_INFINITY
    const ob = orderRank.get(b.slug) ?? Number.POSITIVE_INFINITY
    if (oa !== ob) return oa - ob
    const ra = originalRank.get(a.slug) ?? Number.POSITIVE_INFINITY
    const rb = originalRank.get(b.slug) ?? Number.POSITIVE_INFINITY
    return ra - rb
  })
}

/** Ordered models with hidden ones filtered out — what session/Composer pickers should offer. */
export function orderedVisibleModels(s: AppSettings, instanceId?: string): CatalogModel[] {
  const id = instanceId ?? s.agent.activeInstanceId
  const prefs = s.agent.modelPreferences[id] ?? EMPTY_PREFS
  const visible = instanceModels(s, id).filter((m) => !prefs.hiddenModels.includes(m.slug))
  return sortModels(visible, prefs)
}

/** Same ordering, but hidden models stay in the list (struck-through) — for the settings list view. */
export function orderedModels(s: AppSettings, instanceId?: string): CatalogModel[] {
  const id = instanceId ?? s.agent.activeInstanceId
  const prefs = s.agent.modelPreferences[id] ?? EMPTY_PREFS
  return sortModels(instanceModels(s, id), prefs)
}

/** Session default model: explicit config.model wins (back-compat); else the top ordered visible model. */
export function effectiveDefaultModel(s: AppSettings): string | undefined {
  const cfg = activeInstanceConfig(s)
  if (cfg.model) return cfg.model
  return orderedVisibleModels(s)[0]?.slug
}
