import { z } from 'zod'
import {
  PERMISSION_MODES,
  type AppSettings,
  type ModelPreferences,
  type PermissionMode,
  type ProviderInstance
} from './settings'

export interface FieldAnnotation {
  control: 'text' | 'password' | 'textarea' | 'select' | 'switch' | 'number'
  label: string
  placeholder?: string
  options?: readonly string[]
  order: number
  /** Renders as a secret-store-backed password field (AnnotatedForm `onSecret`); config holds a $secret ref. */
  sensitive?: boolean
  /** Tooltip text shown on the label (title attr) explaining the field's purpose. */
  help?: string
  /** Value treated as "default" by the reset affordance (besides null/''). */
  defaultValue?: unknown
}

export interface CatalogModel {
  slug: string
  name: string
  isCustom?: boolean
}

/**
 * Renderer-visible driver capabilities — a shared-layer mirror of the main-process
 * `AgentDriver.capabilities` (`main/services/agent/driver.ts`). Kept as an independent
 * copy deliberately: this file must never import from `main` (shared-layer rule), and the
 * two are allowed to (temporarily) diverge — Task 9A will make the copilot AgentDriver's
 * own capabilities consistent with what's declared here.
 */
export interface DriverCapabilities {
  permissionModes: readonly PermissionMode[]
  editableApprovals: boolean
  costReporting: boolean
  planMode?: boolean
  /** Whether the driver exposes Argus connector (external MCP) servers to the agent.
   *  Absent = supported; `false` = declared degradation (Copilot v1). Mirrors
   *  `main/services/agent/driver.ts` `DriverCapabilities.mcpConnectors`. */
  mcpConnectors?: boolean
  /** Whether this driver can run a tool-less one-shot prompt with no case and no session.
   *  Explicit and required — unlike `mcpConnectors`, absence here means nothing. */
  headlessOneShot: boolean
}

export interface DriverDefinition {
  kind: string
  label: string
  /** Short display form for compact UI (e.g. the settings provider-card header). Falls back to `label`. */
  shortLabel?: string
  configSchema: z.ZodType
  formAnnotations: Record<string, FieldAnnotation>
  models: readonly CatalogModel[]
  capabilities: DriverCapabilities
}

/** Shared instance-config shape: every driver's config is `{ model?, cliPath?, customModels? }`. */
const agentConfigSchema = z.looseObject({
  model: z.string().optional(), // back-compat: hand-edited config.model still wins (see effectiveDefaultModel)
  cliPath: z.string().optional(),
  customModels: z.array(z.string()).optional()
})
export type AgentDriverConfig = z.infer<typeof agentConfigSchema>
/** @deprecated use `AgentDriverConfig` — kept so pre-Task-8 call sites still compile. */
export type ClaudeDriverConfig = AgentDriverConfig

/** Static built-in catalog (t3code BUILT_IN_MODELS) — unconditional, not user-editable. */
const CLAUDE_MODELS: readonly CatalogModel[] = [
  { slug: 'claude-fable-5', name: 'Claude Fable 5' },
  { slug: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { slug: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  { slug: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { slug: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { slug: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }
]

/**
 * Copilot Free tier exposes only the router (Task 7 evidence, `09-models.jsonl`):
 * `listModels()` returns exactly `[{id:"auto", name:"Auto"}]`; the real underlying models
 * (`gpt-5-mini`, `claude-haiku-4.5`) are chosen per-turn and only discoverable from turn
 * events, not the catalog. `customModels` remains the paid-tier escape hatch for accounts
 * where `listModels()`/`session.setModel()` widen (unverified — Task 9+).
 */
export const COPILOT_MODELS: readonly CatalogModel[] = [{ slug: 'auto', name: 'Auto' }]

export const DRIVERS: Record<string, DriverDefinition> = {
  'claude-agent-sdk': {
    kind: 'claude-agent-sdk',
    label: 'Claude Agent SDK',
    shortLabel: 'Claude',
    configSchema: agentConfigSchema,
    // model is rendered by the dedicated Models section (ProviderModels), not the generic form
    formAnnotations: {
      cliPath: { control: 'text', label: 'Claude CLI path', placeholder: 'auto-detect', order: 2 }
    },
    models: CLAUDE_MODELS,
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: true,
      costReporting: true,
      headlessOneShot: true
    }
  },
  'github-copilot': {
    kind: 'github-copilot',
    label: 'GitHub Copilot',
    shortLabel: 'Copilot',
    configSchema: agentConfigSchema,
    formAnnotations: {
      cliPath: {
        control: 'text',
        label: 'Copilot CLI path',
        placeholder: 'auto-detect',
        order: 2,
        help: 'Path to the copilot binary; leave empty to use the SDK default / PATH.'
      }
    },
    models: COPILOT_MODELS,
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: false,
      costReporting: false,
      planMode: true,
      // mcpConnectors omitted (= supported): resolved by the tools:["*"] allowlist (EVIDENCE §6c)
      headlessOneShot: true
    }
  }
}

export function getDriver(slug: string): DriverDefinition | null {
  return DRIVERS[slug] ?? null
}

/** `<driverKind>-<n>`, lowest `n` not already used by another instance — used by the
 *  Agent settings "Add provider" affordance to mint a fresh instance id. */
export function nextInstanceId(
  instances: Record<string, ProviderInstance>,
  driverKind: string
): string {
  let n = 1
  while (`${driverKind}-${n}` in instances) n++
  return `${driverKind}-${n}`
}

/**
 * Fallback used before settings first load, when the active instance's driver is
 * unknown, AND in the settled settings-IPC-failure state — `SettingsStore.start()`
 * swallows a failed `settings.get()` and the payload then stays null indefinitely,
 * so this is a possible steady state, not just a pre-load flicker. Cosmetic fields
 * stay permissive (the full mode picker), but `editableApprovals` is conservative:
 * offering an edit affordance the active driver may silently drop (Copilot v1)
 * would be a false "your edit applied" signal, while withholding it merely costs
 * a convenience.
 */
const DEFAULT_CAPABILITIES: DriverCapabilities = {
  permissionModes: PERMISSION_MODES,
  editableApprovals: false,
  costReporting: true,
  headlessOneShot: false
}

/** An enabled provider instance paired with its resolved driver, in settings key order. */
export interface EnabledInstance {
  id: string
  instance: ProviderInstance
  driver: DriverDefinition
}

/**
 * Every instance the user has switched on whose driver slug we recognise. More than one may
 * be enabled at a time — the chat model picker aggregates across all of them, and the chosen
 * model is what selects the provider for a session (see {@link allVisibleModels}).
 * Instances naming an unknown driver are skipped rather than surfaced: they have no model
 * catalog to contribute, and settings already flags them separately.
 */
export function enabledInstances(s: AppSettings): EnabledInstance[] {
  const out: EnabledInstance[] = []
  for (const [id, instance] of Object.entries(s.agent.providerInstances)) {
    if (!instance.enabled) continue
    const driver = getDriver(instance.driver)
    if (driver) out.push({ id, instance, driver })
  }
  return out
}

/**
 * The instance used where there is no session to scope to — case distillation, reference
 * sync, the auth probe, the health row — and the seed for a brand-new chat.
 *
 * `activeInstanceId` survives multi-provider precisely because of these callers: background
 * work has no model picker to read from. It is a *default*, not an exclusive selection. When
 * it names a disabled or unknown instance we fall back to the first enabled one instead of
 * failing, so switching a provider off can never strand background work.
 */
export function defaultInstanceId(s: AppSettings): string {
  const named = s.agent.activeInstanceId
  const inst = s.agent.providerInstances[named]
  if (inst?.enabled && getDriver(inst.driver)) return named
  return enabledInstances(s)[0]?.id ?? named
}

/** The default provider instance's driver definition (null if the instance or its
 *  driver slug is unknown — e.g. a hand-edited config, or the settings payload
 *  hasn't resolved that instance yet). */
export function activeDriver(s: AppSettings): DriverDefinition | null {
  const inst = s.agent.providerInstances[defaultInstanceId(s)]
  return inst ? getDriver(inst.driver) : null
}

/** Identifies a model across providers. A bare slug is ambiguous once two instances are
 *  enabled — two Claude accounts both offer `claude-opus-4-8` — so every model reference
 *  that crosses a boundary (IPC, the sessions table, the picker) carries its instance. */
export interface ModelRef {
  instanceId: string
  slug: string
}

export interface AggregatedModel extends CatalogModel {
  instanceId: string
  driverKind: string
  /** Provider display name, for disambiguating the picker when >1 instance is enabled. */
  providerLabel: string
}

/**
 * Visible models across every enabled instance, each instance's own ordering preserved and
 * the instances themselves in settings order. Deliberately NOT deduped by slug: the same
 * slug on two instances is two distinct choices (different account, different config), and
 * collapsing them would silently drop one provider's entry.
 */
export function allVisibleModels(s: AppSettings): AggregatedModel[] {
  return enabledInstances(s).flatMap(({ id, instance, driver }) =>
    orderedVisibleModels(s, id).map((m) => ({
      ...m,
      instanceId: id,
      driverKind: driver.kind,
      providerLabel: instance.displayName?.trim() || (driver.shortLabel ?? driver.label)
    }))
  )
}

/** Seed selection for a new chat: the default instance's default model, else the first
 *  visible model of any enabled provider. Undefined only when nothing is enabled. */
export function defaultModelRef(s: AppSettings): ModelRef | undefined {
  const instanceId = defaultInstanceId(s)
  const cfg = driverConfig<AgentDriverConfig>(
    s.agent.providerInstances[instanceId]?.driver ?? '',
    s.agent.providerInstances[instanceId]?.config
  )
  // explicit config.model still wins (back-compat, same rule as effectiveDefaultModel)
  const slug = cfg.model ?? orderedVisibleModels(s, instanceId)[0]?.slug
  if (slug) return { instanceId, slug }
  const first = allVisibleModels(s)[0]
  return first ? { instanceId: first.instanceId, slug: first.slug } : undefined
}

/**
 * Capabilities of a SPECIFIC instance — what a given session can do, as opposed to
 * {@link activeCapabilities}'s global default. Falls back to the same conservative
 * DEFAULT_CAPABILITIES when the instance or its driver is unknown; see that constant's
 * docblock for why `editableApprovals` must stay false in the unknown case.
 */
export function capabilitiesFor(
  s: AppSettings | null | undefined,
  instanceId: string | null | undefined
): DriverCapabilities {
  if (!s || !instanceId) return DEFAULT_CAPABILITIES
  const inst = s.agent.providerInstances[instanceId]
  return (inst ? getDriver(inst.driver)?.capabilities : undefined) ?? DEFAULT_CAPABILITIES
}

/**
 * Renderer-wide source of truth for "what can the active driver do" — Composer's
 * permission picker, ApprovalCard's edit affordance, and the cost chip all read
 * this instead of hardcoding capabilities. Falls back to DEFAULT_CAPABILITIES
 * when `s` is null/undefined (settings not yet loaded, or settings IPC failed and
 * the payload settled at null) or the driver slug is unknown — see the fallback's
 * own doc comment for why it is conservative on `editableApprovals`.
 */
export function activeCapabilities(s: AppSettings | null | undefined): DriverCapabilities {
  if (!s) return DEFAULT_CAPABILITIES
  return activeDriver(s)?.capabilities ?? DEFAULT_CAPABILITIES
}

/** Validate an opaque instance config against its driver's schema; {} on unknown driver or invalid config. */
export function driverConfig<T>(slug: string, raw: unknown): T {
  const d = getDriver(slug)
  if (!d) return {} as T
  const r = d.configSchema.safeParse(raw ?? {})
  return (r.success ? r.data : {}) as T
}

/** Config of the default provider instance ({} if missing/disabled/unknown driver).
 *  Routed through {@link defaultInstanceId}, so disabling the named instance falls back to
 *  another enabled one rather than silently emptying every background caller's config. */
export function activeInstanceConfig(s: AppSettings): AgentDriverConfig {
  const inst = s.agent.providerInstances[defaultInstanceId(s)]
  if (!inst || !inst.enabled) return {}
  return driverConfig<AgentDriverConfig>(inst.driver, inst.config)
}

const EMPTY_PREFS: ModelPreferences = {
  hiddenModels: [],
  favoriteModels: [],
  modelOrder: []
}

/** The driver's static catalog plus that instance's hand-added custom models (deduped, flagged). */
export function instanceModels(s: AppSettings, instanceId?: string): CatalogModel[] {
  const id = instanceId ?? defaultInstanceId(s)
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
  const id = instanceId ?? defaultInstanceId(s)
  const prefs = s.agent.modelPreferences[id] ?? EMPTY_PREFS
  const visible = instanceModels(s, id).filter((m) => !prefs.hiddenModels.includes(m.slug))
  return sortModels(visible, prefs)
}

/** Same ordering, but hidden models stay in the list (struck-through) — for the settings list view. */
export function orderedModels(s: AppSettings, instanceId?: string): CatalogModel[] {
  const id = instanceId ?? defaultInstanceId(s)
  const prefs = s.agent.modelPreferences[id] ?? EMPTY_PREFS
  return sortModels(instanceModels(s, id), prefs)
}

/** Session default model: explicit config.model wins (back-compat); else the top ordered visible model. */
export function effectiveDefaultModel(s: AppSettings): string | undefined {
  const cfg = activeInstanceConfig(s)
  if (cfg.model) return cfg.model
  return orderedVisibleModels(s)[0]?.slug
}

export type DistillProviderResolution =
  | { ok: true; instanceId: string; driverKind: string; model?: string; cliPath?: string }
  | { ok: false; reason: string }

function distillOk(
  s: AppSettings,
  instanceId: string,
  explicitModel?: string
): DistillProviderResolution {
  const inst = s.agent.providerInstances[instanceId]
  const cfg = driverConfig<AgentDriverConfig>(inst.driver, inst.config)
  return {
    ok: true,
    instanceId,
    driverKind: inst.driver,
    // Scoped to THIS instance. effectiveDefaultModel() resolves against the active
    // instance and is exactly what leaked Copilot's "auto" into the Claude SDK.
    model: explicitModel ?? cfg.model ?? orderedVisibleModels(s, instanceId)[0]?.slug,
    cliPath: cfg.cliPath
  }
}

/**
 * The provider instance headless distillation runs on. Explicit `agent.distillProvider`
 * wins; otherwise the first enabled claude-agent-sdk instance (the contract was authored
 * and tested against Claude). Never consults activeInstanceId.
 */
export function resolveDistillProvider(s: AppSettings): DistillProviderResolution {
  const instances = s.agent.providerInstances
  const explicit = s.agent.distillProvider
  if (explicit?.instanceId) {
    const id = explicit.instanceId
    const inst = instances[id]
    if (!inst || !inst.enabled)
      return { ok: false, reason: `distillation provider "${id}" is unknown or disabled` }
    if (!getDriver(inst.driver)?.capabilities.headlessOneShot)
      return {
        ok: false,
        reason: `provider "${id}" (${inst.driver}) cannot run headless distillation`
      }
    return distillOk(s, id, explicit.model)
  }
  const fallback = Object.keys(instances).find(
    (id) =>
      instances[id].enabled &&
      instances[id].driver === 'claude-agent-sdk' &&
      getDriver(instances[id].driver)?.capabilities.headlessOneShot
  )
  if (!fallback) return { ok: false, reason: 'no provider configured for distillation' }
  return distillOk(s, fallback)
}
