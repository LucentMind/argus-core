import { z } from './zodConfig'
import {
  PERMISSION_MODES,
  type AppSettings,
  type ModelPreferences,
  type PermissionMode,
  type ProviderInstance
} from './settings'
import type { ModelOptionInfo } from './runOptions'
import { findModelEntry, modelMatches, resolvesToId, type ModelIdentity } from './modelIdentity'

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
  /** Wire slug this row's `slug` resolves to, when the row came from a runtime catalog whose
   *  key is a CLI alias (`opus[1m]` → `claude-opus-5[1m]`). Carried so a session pinned to a
   *  STATIC slug still resolves to its alias row — see `shared/modelIdentity.ts`. Absent on
   *  static and custom rows, whose `slug` already is the wire slug. */
  resolvedModel?: string
}

/** A picker row as `shared/modelIdentity.ts` sees it. */
function rowIdentity(m: CatalogModel): ModelIdentity {
  return m.resolvedModel === undefined
    ? { value: m.slug }
    : { value: m.slug, resolvedModel: m.resolvedModel }
}

/** The picker row a pinned model names, via the SHARED resolver the Claude driver's
 *  `catalogFor` also uses — so the composer's chip and the wire can never name different
 *  models. Null when no row matches (e.g. a model the CLI has since dropped). */
export function findModelRow<T extends CatalogModel>(
  rows: readonly T[],
  model: string | null | undefined
): T | null {
  return findModelEntry(rows, model, rowIdentity)
}

/**
 * Which field of the underlying SDK/wire a driver puts Argus's composed system prompt into.
 *
 * `'none'` is a DECLARED DEGRADATION, not an omission: the harness still composes the text and
 * the driver discards it. `'unknown'` exists only for `DEFAULT_CAPABILITIES`, where no driver
 * has been resolved — claiming `'none'` there would assert a bug that may not exist.
 */
export type SystemPromptTransport =
  'systemPrompt.append' | 'systemMessage.append' | 'developerInstructions' | 'none' | 'unknown'

/**
 * How a driver can host review layer subagents (see services/agent/reviewSubagents.ts).
 * - 'configurable': Argus can register named agents with their own prompt and tool allowlist
 *   (Claude SDK `agents`; Copilot `customAgents`).
 * - 'promptable': the backend delegates internally but exposes no registration surface, so the
 *   layer text is inlined into the main turn instead (Codex app-server; ACP has no agent
 *   concept at all — verified against @zed-industries/agent-client-protocol's schema).
 */
export type SubagentSupport = 'configurable' | 'promptable'

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
  /** Which wire field carries the composed system prompt. Explicit and required — like
   *  `headlessOneShot` and unlike `mcpConnectors`, absence here would mean nothing, and the
   *  point of this field is that a new driver cannot skip the question. */
  systemPromptTransport: SystemPromptTransport
  /** Explicit and required, like `headlessOneShot`: absence has no safe default here. */
  subagents: SubagentSupport
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

/** Codex static built-in catalog (spec §6 / t3code BUILT_IN_MODELS port). `gpt-5.4` is the default. */
export const CODEX_MODELS: readonly CatalogModel[] = [
  { slug: 'gpt-5.4', name: 'GPT-5.4 (Codex)' },
  { slug: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  { slug: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' }
]

/** Cursor CLI (`cursor-agent`) ACP model catalog — slugs per the ACP driver plan (Task 1),
 *  pending live verification against the real CLI. */
export const CURSOR_MODELS: readonly CatalogModel[] = [
  { slug: 'auto', name: 'Auto' },
  { slug: 'composer-2', name: 'Composer 2' },
  { slug: 'composer-1.5', name: 'Composer 1.5' }
]

/** Grok (xAI) ACP model catalog — slug per the ACP driver plan (Task 1), pending live
 *  verification against the real CLI. */
export const GROK_MODELS: readonly CatalogModel[] = [{ slug: 'grok-build', name: 'Grok Build' }]

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
      headlessOneShot: true,
      // options.systemPrompt = { type:'preset', preset:'claude_code', append: ctx.systemAppend }
      systemPromptTransport: 'systemPrompt.append',
      subagents: 'configurable'
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
      headlessOneShot: true,
      // sessionConfig.systemMessage = { mode:'append', content: ctx.systemAppend }
      systemPromptTransport: 'systemMessage.append',
      subagents: 'configurable'
    }
  },
  codex: {
    kind: 'codex',
    label: 'OpenAI Codex',
    shortLabel: 'Codex',
    // model is rendered by the dedicated Models section (ProviderModels), not the generic form
    configSchema: agentConfigSchema,
    formAnnotations: {
      cliPath: {
        control: 'text',
        label: 'Codex CLI path',
        placeholder: 'codex',
        order: 2,
        help: 'Path to the codex binary; leave empty to auto-detect / use PATH.'
      },
      codexHome: {
        control: 'text',
        label: 'CODEX_HOME path',
        placeholder: '~/.codex',
        order: 3,
        help: 'Per-instance Codex home (keeps auth.json separate for multi-account).'
      }
    },
    models: CODEX_MODELS,
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: false,
      costReporting: false, // no dollar cost on the wire (contract §7) — matches main's driver
      planMode: true,
      headlessOneShot: true,
      // startParams.developerInstructions, omitted entirely when systemAppend is empty
      systemPromptTransport: 'developerInstructions',
      subagents: 'promptable'
    }
  },
  cursor: {
    kind: 'cursor',
    label: 'Cursor',
    shortLabel: 'Cursor',
    configSchema: agentConfigSchema,
    formAnnotations: {
      cliPath: {
        control: 'text',
        label: 'Cursor agent path',
        placeholder: 'cursor-agent',
        order: 2
      }
    },
    models: CURSOR_MODELS,
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: false,
      costReporting: false,
      planMode: true,
      // connectors not yet forwarded — toAcpMcpServers drops them; see session.mcp.skipped
      mcpConnectors: false,
      headlessOneShot: false,
      // KNOWN GAP, declared rather than hidden: ACP `newSession` takes no system prompt and the
      // driver never reads ctx.systemAppend, so persona / citation rules / mode identity / skill
      // index / memory index all go nowhere. Fixing it (a first-turn preamble) is its own plan;
      // this declaration is what makes the loss visible instead of silent.
      systemPromptTransport: 'none',
      subagents: 'promptable'
    }
  },
  grok: {
    kind: 'grok',
    label: 'Grok (xAI)',
    shortLabel: 'Grok',
    configSchema: agentConfigSchema,
    formAnnotations: {
      cliPath: { control: 'text', label: 'Grok CLI path', placeholder: 'grok', order: 2 }
    },
    models: GROK_MODELS,
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: false,
      costReporting: false,
      planMode: true,
      // connectors not yet forwarded — toAcpMcpServers drops them; see session.mcp.skipped
      mcpConnectors: false,
      headlessOneShot: false,
      // KNOWN GAP, declared rather than hidden: ACP `newSession` takes no system prompt and the
      // driver never reads ctx.systemAppend, so persona / citation rules / mode identity / skill
      // index / memory index all go nowhere. Fixing it (a first-turn preamble) is its own plan;
      // this declaration is what makes the loss visible instead of silent.
      systemPromptTransport: 'none',
      subagents: 'promptable'
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
  headlessOneShot: false,
  // No driver resolved, so we genuinely do not know. 'none' would be a claim, not a default.
  systemPromptTransport: 'unknown',
  subagents: 'promptable'
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
 *
 * `rowOverrides` substitutes the ROWS for one or more specific instances — e.g. a session's
 * live runtime catalog — while every other instance keeps its normal
 * {@link orderedVisibleModels} behaviour (visibility + ordering preferences included). This
 * is deliberately per-instance, not global: with multiple providers enabled at once the
 * model picker is how the user switches provider, so one instance's catalog must never
 * suppress every other instance's rows. An instance present in the map with an empty row
 * list is treated as "no override" (falls through to its normal rows) so callers can pass a
 * catalog that hasn't loaded yet without special-casing it.
 *
 * A substituted instance still gets that instance's OWN model preferences applied — see
 * {@link applyModelPreferences}. Bypassing them (as this used to) meant a model the user
 * hid in Settings reappeared, a custom model they added became unselectable, and their
 * favourites/ordering silently stopped applying the moment a catalog loaded.
 */
export function allVisibleModels(
  s: AppSettings,
  rowOverrides?: Record<string, readonly CatalogModel[]>
): AggregatedModel[] {
  return enabledInstances(s).flatMap(({ id, instance, driver }) => {
    const override = rowOverrides?.[id]
    const rows =
      override && override.length > 0
        ? applyModelPreferences(s, id, [...override, ...customModelRows(s, id, override)])
        : orderedVisibleModels(s, id)
    return rows.map((m) => ({
      ...m,
      instanceId: id,
      driverKind: driver.kind,
      providerLabel: instance.displayName?.trim() || (driver.shortLabel ?? driver.label)
    }))
  })
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

/**
 * True when custom slug `slug` duplicates catalog row `m`'s identity — deliberately NOT
 * `modelMatches`. `modelMatches` strips a trailing `[1m]` on both sides so a session pinned at
 * the suffix still finds its base row's capabilities, but that same stripping would swallow an
 * explicitly hand-added `claude-sonnet-5[1m]` custom model into its base `claude-sonnet-5` row
 * and silently drop it from the picker — a real regression, since `[1m]` is the documented way
 * to request 1M context and the user added it on purpose. This keeps exact-slug matching (so a
 * genuine duplicate like re-adding `claude-sonnet-5` is still deduped) plus the `resolvedModel`
 * date-suffix rule (`shared/modelIdentity.ts`'s `resolvesToId`), without `bare()`'s `[1m]` strip.
 */
function duplicatesCatalogRow(m: CatalogModel, slug: string): boolean {
  const id = rowIdentity(m)
  if (id.value === slug) return true
  return id.resolvedModel !== undefined && resolvesToId(id.resolvedModel, slug)
}

/**
 * One instance's hand-added custom models, as rows — deduped against `existing` (so a custom
 * `claude-opus-5` is not offered twice next to a runtime catalog row resolving to the same
 * model) and against each other.
 */
function customModelRows(
  s: AppSettings,
  instanceId: string,
  existing: readonly CatalogModel[]
): CatalogModel[] {
  const inst = s.agent.providerInstances[instanceId]
  if (!inst || !inst.enabled) return []
  const cfg = driverConfig<Record<string, unknown>>(inst.driver, inst.config)
  const rawCustom = Array.isArray(cfg.customModels) ? cfg.customModels : []
  const seen = new Set<string>()
  const customs: CatalogModel[] = []
  for (const slug of rawCustom) {
    if (typeof slug !== 'string' || seen.has(slug)) continue
    if (existing.some((m) => duplicatesCatalogRow(m, slug))) continue
    seen.add(slug)
    customs.push({ slug, name: slug, isCustom: true })
  }
  return customs
}

/** The driver's static catalog plus that instance's hand-added custom models (deduped, flagged). */
export function instanceModels(s: AppSettings, instanceId?: string): CatalogModel[] {
  const id = instanceId ?? defaultInstanceId(s)
  const inst = s.agent.providerInstances[id]
  if (!inst || !inst.enabled) return [] // same gate as activeInstanceConfig
  const catalog = getDriver(inst.driver)?.models ?? []
  return [...catalog, ...customModelRows(s, id, catalog)]
}

/**
 * Turns a wire model id into a human name when nothing in `CLAUDE_MODELS` already names it:
 * strips a trailing `-YYYYMMDD` date segment (the CLI's dated ids, e.g.
 * `claude-haiku-4-5-20251001`), then title-cases each `-`-separated word, joining consecutive
 * purely-numeric segments with `.` instead of a space — `claude-opus-5` → `Claude Opus 5`,
 * `claude-sonnet-4-6` → `Claude Sonnet 4.6`. That numeric-join rule is not invented for this:
 * it is the exact pattern `CLAUDE_MODELS`' own names already follow for every multi-part
 * version (`4-8` → `4.8`, `4-6` → `4.6`), so a prettified slug reads the same as a hand-written
 * catalog entry would.
 */
function prettifyModelSlug(id: string): string {
  const withoutDate = id.replace(/-\d{8}$/, '')
  const words: string[] = []
  let numGroup: string[] = []
  const flushNumGroup = (): void => {
    if (numGroup.length > 0) {
      words.push(numGroup.join('.'))
      numGroup = []
    }
  }
  for (const part of withoutDate.split('-').filter(Boolean)) {
    if (/^\d+$/.test(part)) {
      numGroup.push(part)
    } else {
      flushNumGroup()
      words.push(part.charAt(0).toUpperCase() + part.slice(1))
    }
  }
  flushNumGroup()
  return words.join(' ')
}

/**
 * The name to show for a runtime catalog row, derived from `resolvedModel` (the actual wire
 * slug) rather than the CLI's own `displayName` — the terse alias label ("Opus (1M context)",
 * "Fable", "Sonnet") is unrecognisable next to the model names everywhere else in the app.
 *
 * A trailing `[1m]` is stripped before matching (it names a context-window variant, not a
 * different model) and reapplied as a ` (1M)` suffix on the result — that distinction is real
 * and worth keeping visible, unlike the alias itself.
 */
function displayNameForResolved(resolvedModel: string): string {
  const isOneM = resolvedModel.endsWith('[1m]')
  const bareModel = isOneM ? resolvedModel.slice(0, -'[1m]'.length) : resolvedModel
  const known = CLAUDE_MODELS.find((m) => resolvesToId(bareModel, m.slug))
  const base = known ? known.name : prettifyModelSlug(bareModel)
  return isOneM ? `${base} (1M)` : base
}

/**
 * The model rows to offer for a Claude instance.
 *
 * Mostly a CONVERSION of one instance's reported runtime catalog into picker rows — the old
 * `staticModels` parameter was dead (the only production call site passed `[]`). Whether and
 * when these rows substitute is decided in {@link allVisibleModels} via its per-instance
 * `rowOverrides` parameter. Substitution is per-instance by design: with multiple providers
 * enabled at once, the model picker is how the user switches between them, so one instance's
 * catalog must never suppress other providers.
 *
 * Two things beyond a straight conversion:
 *
 * 1. Naming: see {@link displayNameForResolved}. `resolvedModel` is also carried through as
 *    the row's own `resolvedModel` field, deliberately — without it a session pinned to a
 *    static wire slug matches no alias-keyed row at all (see `shared/modelIdentity.ts`).
 *
 * 2. Dedup: two aliases can resolve to the identical model (the fixture's `default` and
 *    `opus[1m]` both report `resolvedModel: "claude-opus-5[1m]"`) — that is one model, not
 *    two, and listing it twice is confusing rather than informative. Rows sharing a
 *    `resolvedModel` collapse to one, keeping whichever alias is NOT `'default'` — the generic
 *    alias tells the user nothing a specific one doesn't, while `opus[1m]` (or whichever
 *    specific alias resolves the same way) is at least a real, distinguishing name. A row
 *    with no `resolvedModel` at all (never observed live, but the type allows it) is always
 *    kept — there is no shared identity to dedupe it against.
 */
export function catalogModelRows(catalog: readonly ModelOptionInfo[]): CatalogModel[] {
  const rows = catalog.map((m) => ({
    slug: m.value,
    name: m.resolvedModel === undefined ? m.displayName : displayNameForResolved(m.resolvedModel),
    ...(m.resolvedModel === undefined ? {} : { resolvedModel: m.resolvedModel })
  }))
  const kept: CatalogModel[] = []
  const indexByResolved = new Map<string, number>()
  for (const row of rows) {
    if (row.resolvedModel === undefined) {
      kept.push(row)
      continue
    }
    const existingIndex = indexByResolved.get(row.resolvedModel)
    if (existingIndex === undefined) {
      indexByResolved.set(row.resolvedModel, kept.length)
      kept.push(row)
      continue
    }
    // Duplicate resolvedModel: prefer whichever alias is not the generic `default`.
    if (kept[existingIndex].slug === 'default' && row.slug !== 'default') kept[existingIndex] = row
  }
  return kept
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

/**
 * Rewrite one instance's stored preferences so their slugs name ROWS of `rows`.
 *
 * A preference is stored as whatever slug the picker offered when the user set it — in
 * practice a static wire slug like `claude-opus-5`. Substituted runtime rows are keyed by CLI
 * alias (`opus[1m]`), so string equality against them matches nothing, which is how hiding a
 * model in Settings stopped taking effect the moment a catalog loaded. Mapping goes through
 * the same shared resolver as everything else.
 *
 * A preference that maps to NO row is simply dropped from the rewritten list — it is not a
 * reason to drop or reorder anything. `modelOrder` keeps the user's ordering; where one
 * preference maps to several rows they all take that rank position, in row order.
 */
function translatePreferences(
  rows: readonly CatalogModel[],
  prefs: ModelPreferences
): ModelPreferences {
  const mapped = (slugs: readonly string[]): string[] => {
    const out: string[] = []
    for (const pref of slugs) {
      for (const r of rows) {
        if (modelMatches(rowIdentity(r), pref) && !out.includes(r.slug)) out.push(r.slug)
      }
    }
    return out
  }
  return {
    ...prefs,
    hiddenModels: mapped(prefs.hiddenModels),
    favoriteModels: mapped(prefs.favoriteModels),
    modelOrder: mapped(prefs.modelOrder)
  }
}

/** `orderedVisibleModels`' hide-then-sort step, applied to rows supplied by the caller —
 *  used by {@link allVisibleModels}' substitution path so a loaded catalog does not discard
 *  the instance's Settings preferences. */
function applyModelPreferences(
  s: AppSettings,
  instanceId: string,
  rows: readonly CatalogModel[]
): CatalogModel[] {
  const prefs = translatePreferences(rows, s.agent.modelPreferences[instanceId] ?? EMPTY_PREFS)
  return sortModels(
    rows.filter((m) => !prefs.hiddenModels.includes(m.slug)),
    prefs
  )
}

/** Ordered models with hidden ones filtered out — what session/Composer pickers should offer. */
export function orderedVisibleModels(s: AppSettings, instanceId?: string): CatalogModel[] {
  const id = instanceId ?? defaultInstanceId(s)
  return applyModelPreferences(s, id, instanceModels(s, id))
}

/** Same ordering, but hidden models stay in the list (struck-through) — for the settings list view. */
export function orderedModels(s: AppSettings, instanceId?: string): CatalogModel[] {
  const id = instanceId ?? defaultInstanceId(s)
  const prefs = s.agent.modelPreferences[id] ?? EMPTY_PREFS
  return sortModels(instanceModels(s, id), prefs)
}

/**
 * `orderedModels`, but for an instance whose Settings panel should show a loaded runtime
 * catalog (see `catalogModelRows`) instead of the driver's static list — the Claude provider
 * card, once its catalog has arrived. `builtinRows` replaces the driver's static catalog when
 * non-empty; custom models are still layered on top and deduped against it exactly as
 * {@link instanceModels} does for the static case.
 *
 * Preferences are translated through {@link translatePreferences} — the SAME helper
 * {@link applyModelPreferences} uses for the Composer's picker substitution — rather than read
 * raw off `s.agent.modelPreferences`, because `builtinRows` here is alias-keyed while a stored
 * preference is a wire slug (see that function's own doc comment). Returning the translated
 * `ModelPreferences` alongside the rows (not just the sorted list) is what lets the caller
 * compute accurate hidden/favourite sets AND still round-trip a toggle back through
 * `settingsStore.patch` using the rows' own slugs.
 */
export function modelsForSettingsPanel(
  s: AppSettings,
  instanceId: string,
  builtinRows?: readonly CatalogModel[]
): { models: CatalogModel[]; prefs: ModelPreferences; builtins: readonly CatalogModel[] } {
  const inst = s.agent.providerInstances[instanceId]
  const builtins =
    builtinRows && builtinRows.length > 0
      ? builtinRows
      : (getDriver(inst?.driver ?? '')?.models ?? [])
  const rows = inst?.enabled ? [...builtins, ...customModelRows(s, instanceId, builtins)] : builtins
  const prefs = translatePreferences(rows, s.agent.modelPreferences[instanceId] ?? EMPTY_PREFS)
  return { models: sortModels(rows, prefs), prefs, builtins }
}

/** True when `slug` already names one of `rows` — by alias, wire slug, or `resolvedModel` (see
 *  `duplicatesCatalogRow`). Shared by custom-model dedup ({@link customModelRows}, silent) and
 *  the Settings panel's "already built in" validation (loud, `ProviderModels.tsx`), so the two
 *  checks cannot disagree — without this a slug the picker silently dropped as a duplicate
 *  could still sail past the add-form's own check under a loaded runtime catalog, where
 *  built-in rows are alias-keyed rather than wire-slug-keyed. */
export function catalogRowNames(rows: readonly CatalogModel[], slug: string): boolean {
  return rows.some((m) => duplicatesCatalogRow(m, slug))
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
