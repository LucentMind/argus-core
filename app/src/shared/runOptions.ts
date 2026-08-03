import { resolvesToId } from './modelIdentity'

/** The subset of the SDK's `ModelInfo` that option descriptors are derived from.
 *  Declared here rather than imported so `shared/` stays free of SDK types. */
export interface ModelOptionInfo {
  value: string
  resolvedModel?: string
  displayName: string
  supportsEffort?: boolean
  supportedEffortLevels?: readonly string[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

export interface RunOptionChoice {
  value: string
  label: string
  isDefault?: boolean
}

export type RunOptionDescriptor =
  | {
      type: 'select'
      id: string
      label: string
      options: readonly RunOptionChoice[]
      /** Values applied by prefixing the prompt rather than by a wire flag. */
      promptInjected?: readonly string[]
    }
  | {
      type: 'boolean'
      id: string
      label: string
      /** The value this toggle has when nothing is stored. Present because not every SDK
       *  boolean is off-by-default: `alwaysThinkingEnabled` is ON unless explicitly `false`
       *  (absent and `true` mean the same thing), so a chip that rendered an unset boolean as
       *  "Off" was reporting the opposite of what the wire actually does. */
      defaultOn?: boolean
    }

export type RunOptionSelection = { id: string; value: string | boolean }

/**
 * True when this model string pins 1M context by itself, leaving nothing for the Context
 * Window control to choose. That is any slug already carrying the `[1m]` suffix: the CLI's own
 * `opus[1m]` alias row (the only Opus the runtime catalog offers), and any custom model the
 * user hand-added at the suffix — `shared/drivers.ts`' custom-model dedupe keeps those distinct
 * from their base slug precisely because the suffix is a deliberate choice.
 */
function forcesOneMillion(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.endsWith('[1m]')
}

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max'
}

const ALL_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** Which options a given model is curated to show. See {@link MODEL_OPTION_POLICY}. */
export interface ModelOptionPolicy {
  /** Effort levels this model may offer. NARROWS what the model reports — a level listed
   *  here that the model does not report is still not shown. */
  effortLevels?: readonly string[]
  /** Which level reads as selected when nothing is stored. Defaults to `high`. */
  defaultEffort?: string
  ultracode?: boolean
  /** Ultrathink is prompt text and costs nothing, so it defaults to ON wherever there is a
   *  Reasoning control. Only an explicit `false` withholds it. */
  ultrathink?: boolean
  contextWindow?: boolean
  fastMode?: boolean
  thinking?: boolean
}

/**
 * Per-model option curation, ported from t3code's `BUILT_IN_MODELS`
 * (`apps/server/src/provider/Layers/ClaudeProvider.ts`) on 2026-08-03.
 *
 * ⚠️ **PROVISIONAL — EXPECTED TO CHANGE.** This is adopted deliberately as a starting point,
 * not because it is known to be correct. t3code's table is hand-maintained and demonstrably
 * disagrees with Argus's own live measurements in both directions (see the divergence list
 * below). Revisit it whenever the CLI's model line-up moves, and prefer a fresh measurement
 * over this table wherever the two conflict.
 *
 * **This table may only NARROW what the model reports, never widen it.** Every entry is
 * intersected with real capability data (`supportsEffort`/`supportedEffortLevels`/
 * `supportsFastMode`), so porting one of t3code's false positives cannot make Argus offer a
 * control the wire then rejects. That rule is load-bearing — see the Opus 4.7 row.
 *
 * Where this table disagrees with what Argus measured, and what happens:
 *
 * - **Sonnet 4.6 loses `xhigh` (and with it Ultracode) — t3code is RIGHT.** Measured
 *   2026-08-03 via an ANTHROPIC_BASE_URL capture: `effort:'xhigh'` leaves the CLI as
 *   `output_config.effort = "high"` on this model alone; every other effort-capable model
 *   passes `xhigh` through unchanged. Ultracode is `xhigh` + `settings.ultracode`, so it was
 *   landing two levels below what the chip claimed. This is the defect that prompted the port.
 * - **Opus 4.7 and Sonnet 5 lose Ultracode — t3code is UNVERIFIED here.** Both pass `xhigh`
 *   through fine, so the effort half of Ultracode works on them. t3code withholds it anyway
 *   and we follow, for now.
 * - **Opus 4.8 and Opus 4.7 lose Context Window — t3code CONTRADICTS a measurement.**
 *   `drivers.ts` records the `[1m]` suffix succeeding on both. This port removes a control
 *   that demonstrably worked; it is the clearest candidate to revert on revisit.
 * - **Opus 4.7 keeps NO Fast Mode despite t3code granting it — the narrowing rule saves us.**
 *   Argus measured fast mode returning API 400 ("does not support the `speed` parameter") on
 *   this model, and `supportsFastMode` is false for it, so the intersection drops it. Porting
 *   t3code naively here would have shipped a button that errors.
 * - **Opus 5 has no t3code entry at all** — its table predates that model. That row is
 *   Argus-originated, shaped after Opus 4.8 (its nearest analogue) plus Context Window, which
 *   is measured to work and which the CLI's own `opus[1m]` alias makes unavoidable anyway.
 *
 * Keyed by Argus's undated wire slug; matching tolerates a `[1m]` suffix and the CLI's
 * `-YYYYMMDD` date segment (see {@link policyFor}). A model absent from this table falls back
 * to pure capability derivation, so a newly-released model is never silently stripped of its
 * options — it simply is not curated yet.
 */
export const MODEL_OPTION_POLICY: Readonly<Record<string, ModelOptionPolicy>> = {
  'claude-fable-5': { effortLevels: ALL_LEVELS, ultracode: true, contextWindow: true },
  // Argus-originated (see above): t3code has no Opus 5 row.
  'claude-opus-5': {
    effortLevels: ALL_LEVELS,
    ultracode: true,
    contextWindow: true,
    fastMode: true
  },
  'claude-opus-4-8': { effortLevels: ALL_LEVELS, ultracode: true, fastMode: true },
  // t3code defaults this model to xhigh rather than high — ported as-is.
  'claude-opus-4-7': { effortLevels: ALL_LEVELS, defaultEffort: 'xhigh', fastMode: true },
  'claude-sonnet-5': { effortLevels: ALL_LEVELS, contextWindow: true },
  'claude-sonnet-4-6': {
    effortLevels: ['low', 'medium', 'high', 'max'],
    contextWindow: true
  },
  'claude-haiku-4-5': { thinking: true }
}

/**
 * The policy row for this model, or undefined when it is not curated.
 *
 * Tries the pinned wire slug first, then the row's `resolvedModel`, then its `value` — the
 * catalog keys rows by ALIAS (`sonnet`), so `value` alone usually cannot match a policy key.
 * `[1m]` is stripped and a `-YYYYMMDD` segment tolerated, the same union
 * `shared/modelIdentity.ts` applies everywhere else a model string is matched to a row.
 */
function policyFor(info: ModelOptionInfo, model?: string | null): ModelOptionPolicy | undefined {
  const candidates = [model, info.resolvedModel, info.value]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map((s) => s.replace(/\[1m\]$/, ''))
  for (const [key, policy] of Object.entries(MODEL_OPTION_POLICY)) {
    if (candidates.some((c) => resolvesToId(c, key))) return policy
  }
  return undefined
}

/**
 * Build a model's option descriptors from what the CLI reports about it.
 *
 * Ultracode and Ultrathink are appended by us: neither appears in
 * `supportedEffortLevels` on any model, because neither is an effort level.
 * Ultracode is a Settings key that pairs with xhigh (hence the gate); Ultrathink
 * is prompt text.
 *
 * `model` is the string the session is actually pinned to, when the caller knows it. It is
 * NOT the same as `info.value`: a session pinned to `claude-fable-5[1m]` resolves to the bare
 * `fable` row, and the CLI's own `opus[1m]` alias row carries the suffix in its `value`. What
 * matters for the context window is the string that goes on the wire, which is why this takes
 * the model rather than reading the row — see {@link forcesOneMillion}.
 */
export function descriptorsFor(
  info: ModelOptionInfo,
  model?: string | null
): RunOptionDescriptor[] {
  const out: RunOptionDescriptor[] = []
  const policy = policyFor(info, model)
  const reported = info.supportsEffort ? (info.supportedEffortLevels ?? []) : []
  // Intersection, in the model's own reported order: the policy narrows, capability data
  // gates. Neither alone can put a level on screen.
  const levels = policy?.effortLevels
    ? reported.filter((l) => policy.effortLevels!.includes(l))
    : reported
  const wantDefault = policy?.defaultEffort ?? 'high'

  if (levels.length > 0) {
    const options: RunOptionChoice[] = levels.map((v) => ({
      value: v,
      label: EFFORT_LABELS[v] ?? v,
      ...(v === wantDefault ? { isDefault: true as const } : {})
    }))
    if (!options.some((o) => o.isDefault) && options.length > 0) options[0].isDefault = true
    // Ultracode rides on xhigh, so it needs BOTH the level and the policy's blessing. On an
    // uncurated model it falls back to the old rule (xhigh implies Ultracode).
    const wantUltracode = policy ? policy.ultracode === true : levels.includes('xhigh')
    if (wantUltracode && levels.includes('xhigh')) {
      options.push({ value: 'ultracode', label: 'Ultracode' })
    }
    if (policy?.ultrathink !== false) options.push({ value: 'ultrathink', label: 'Ultrathink' })
    out.push({
      type: 'select',
      id: 'effort',
      label: 'Reasoning',
      options,
      promptInjected: ['ultrathink']
    })

    // Measured against a live CLI: the `[1m]` slug suffix succeeds on every
    // effort-capable model and returns API 400 on Haiku, which reports no effort.
    // The catalog's alias rows are NOT the signal — only `opus` has a [1m] row,
    // yet fable and sonnet both accept the suffix.
    //
    // A model pinned AT the suffix has no 200k position to offer: `apiModelId` cannot remove a
    // suffix the slug already carries, so a "200k" choice there was inert — it rendered as the
    // default and selected value while every send went out at 1M. One option is not a
    // pointless control: it is the honest report of a window the user cannot change here.
    //
    // A curated model shows this only when its policy row asks for it. That is how the port
    // takes Context Window away from Opus 4.8/4.7 — a deliberate, and the most questionable,
    // consequence of adopting t3code's table (see MODEL_OPTION_POLICY).
    if (policy ? policy.contextWindow === true : true) {
      out.push({
        type: 'select',
        id: 'contextWindow',
        label: 'Context Window',
        options: forcesOneMillion(model)
          ? [{ value: '1m', label: '1M', isDefault: true }]
          : [
              { value: '200k', label: '200k', isDefault: true },
              { value: '1m', label: '1M' }
            ]
      })
    }
  }

  // Policy narrows, capability gates — so t3code granting Opus 4.7 fast mode cannot resurrect
  // a control Argus measured returning API 400 on that model.
  if (info.supportsFastMode && (policy ? policy.fastMode === true : true)) {
    out.push({ type: 'boolean', id: 'fastMode', label: 'Fast Mode' })
  }

  // Thinking is offered ONLY to a model with no Reasoning control — deliberately NOT gated on
  // `supportsAdaptiveThinking`, which is the wrong question in both directions.
  //
  // Measured 2026-08-03 by pointing ANTHROPIC_BASE_URL at a local server and reading the
  // outbound `/v1/messages` body (see [[argus-verify-empirically-over-types]] for the recipe):
  //
  //   haiku, nothing set            -> thinking {"type":"enabled","budget_tokens":31999}
  //   haiku, alwaysThinkingEnabled:false -> thinking {"type":"disabled"}
  //   fable, nothing set            -> thinking {"type":"adaptive"}
  //   fable, alwaysThinkingEnabled:false -> thinking absent
  //
  // So the flag's absence never meant "no thinking control": Haiku reports NO capabilities at
  // all in `supportedModels()` yet honours the toggle on the wire with a fixed 32k budget.
  // `supportsAdaptiveThinking` reports whether thinking is *adaptive*, which is a different
  // question from whether it can be turned off. Both halves of the run confirm the toggle is
  // real, so the choice of who sees it is a CURATION call, not a capability one.
  //
  // The curation: Reasoning already spans the same axis, more expressively — a model offering
  // both asks the user to reconcile "Extra High" against "Thinking On", and in practice nobody
  // reaches for a top-tier model in order to turn its thinking off. So the toggle appears only
  // where Reasoning cannot: Haiku today, and automatically any future effort-less model.
  //
  // `defaultOn` is inverted deliberately: thinking is ON unless the SDK is told
  // `alwaysThinkingEnabled: false`, so only "Off" is a real, wire-visible choice — confirmed
  // above, where the unset run still sent `"type":"enabled"`.
  //
  // A curated model takes its policy row's answer instead; t3code grants Thinking to Haiku
  // alone, which is the same set this rule produces on today's line-up.
  if (policy ? policy.thinking === true : levels.length === 0) {
    out.push({ type: 'boolean', id: 'thinking', label: 'Thinking', defaultOn: true })
  }
  return out
}

function rawStored(
  stored: readonly RunOptionSelection[] | null | undefined,
  id: string
): string | boolean | undefined {
  return stored?.find((s) => s.id === id)?.value
}

/**
 * The effective value of one descriptor given what the session stored.
 *
 * Selects fall back to `isDefault` when the stored value is absent OR is not a
 * choice this model offers — that second half is what stops a value from
 * sticking across a model switch. Booleans take the stored boolean when there is
 * one and the descriptor's `defaultOn` otherwise; anything non-boolean stored
 * against a boolean descriptor is garbage and falls back the same way.
 */
export function selectionValue(
  d: RunOptionDescriptor,
  stored: readonly RunOptionSelection[] | null | undefined
): string | boolean | undefined {
  const raw = rawStored(stored, d.id)
  if (d.type === 'boolean') return typeof raw === 'boolean' ? raw : (d.defaultOn ?? false)
  if (typeof raw === 'string' && d.options.some((o) => o.value === raw)) return raw
  return d.options.find((o) => o.isDefault)?.value
}

/**
 * What to persist: only selections that are valid for the current descriptors AND
 * differ from the default. Storing a value equal to the default would freeze it, so
 * a later default change could never reach the session.
 */
export function pruneSelections(
  ds: readonly RunOptionDescriptor[],
  stored: readonly RunOptionSelection[] | null | undefined
): RunOptionSelection[] {
  const out: RunOptionSelection[] = []
  for (const d of ds) {
    const raw = rawStored(stored, d.id)
    if (d.type === 'boolean') {
      // Same rule as selects: store only what DIFFERS from the default. For a `defaultOn`
      // toggle that means `false` is the value worth persisting and `true` is the no-op.
      if (typeof raw === 'boolean' && raw !== (d.defaultOn ?? false)) {
        out.push({ id: d.id, value: raw })
      }
      continue
    }
    if (typeof raw !== 'string') continue
    if (!d.options.some((o) => o.value === raw)) continue
    if (d.options.find((o) => o.isDefault)?.value === raw) continue
    out.push({ id: d.id, value: raw })
  }
  return out
}

/** Human-readable current value, used for chip text and the collapsed trigger. */
export function selectionLabel(
  d: RunOptionDescriptor,
  stored: readonly RunOptionSelection[] | null | undefined
): string {
  const v = selectionValue(d, stored)
  if (d.type === 'boolean') return v === true ? 'On' : 'Off'
  return d.options.find((o) => o.value === v)?.label ?? ''
}

/** Wire ordering of the real effort levels, weakest first. Used to degrade. */
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * The value for the SDK's `effort` option.
 *
 * `ultracode` is not an effort level — it is a Settings key that pairs with
 * xhigh, so it maps to xhigh here and is set separately in `claudeSettingsFor`.
 * `ultrathink` is prompt text and yields nothing.
 *
 * A level the model does not report supporting resolves to the NEAREST supported
 * level, preferring lower: it walks down first, and only when nothing supported
 * lies below the request does it take the model's lowest level. That floor case
 * deliberately lands ABOVE the request — returning undefined instead would omit
 * `effort` entirely and let the SDK apply its own default, which is `high`, and
 * therefore further from a `low` request than the floor value is.
 *
 * Keying off the model's reported set rather than a hardcoded table is what
 * stops this going stale when the catalog changes.
 */
export function effectiveEffort(
  d: RunOptionDescriptor | undefined,
  value: string | boolean | undefined
): string | undefined {
  if (!d || d.type !== 'select' || typeof value !== 'string') return undefined
  if (value === 'ultrathink') return undefined
  const wanted = value === 'ultracode' ? 'xhigh' : value
  const supported = d.options
    .map((o) => o.value)
    .filter((v): v is (typeof EFFORT_ORDER)[number] =>
      (EFFORT_ORDER as readonly string[]).includes(v)
    )
  if (supported.length === 0) return undefined
  if (supported.includes(wanted as (typeof EFFORT_ORDER)[number])) return wanted
  const wantedIdx = EFFORT_ORDER.indexOf(wanted as (typeof EFFORT_ORDER)[number])
  if (wantedIdx < 0) return undefined
  for (let i = wantedIdx - 1; i >= 0; i--) {
    if (supported.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i]
  }
  return supported[0]
}

/**
 * 1M context is a model-slug suffix, not a beta header. Measured live: the CLI's own
 * catalog reports `resolvedModel: "claude-opus-5[1m]"`, and the suffix succeeds on
 * every effort-capable model.
 */
export function apiModelId(slug: string, contextWindow: string | boolean | undefined): string {
  if (contextWindow !== '1m') return slug
  return slug.endsWith('[1m]') ? slug : `${slug}[1m]`
}

/** The SDK `settings` object for this selection. Empty means "pass nothing". */
export function claudeSettingsFor(
  ds: readonly RunOptionDescriptor[],
  stored: readonly RunOptionSelection[] | null | undefined
): { ultracode?: true; fastMode?: true; alwaysThinkingEnabled?: boolean } {
  const out: { ultracode?: true; fastMode?: true; alwaysThinkingEnabled?: boolean } = {}
  const effort = ds.find((d) => d.id === 'effort')
  if (effort && selectionValue(effort, stored) === 'ultracode') out.ultracode = true
  const fast = ds.find((d) => d.id === 'fastMode')
  if (fast && selectionValue(fast, stored) === true) out.fastMode = true
  // Only `false` is meaningful for alwaysThinkingEnabled — absent and `true` both leave
  // thinking on — so this writes the flag ONLY when the user has actually turned it off.
  // Sending `true` (the old behaviour) made both chip positions no-ops on the wire.
  const thinking = ds.find((d) => d.id === 'thinking')
  if (thinking && selectionValue(thinking, stored) === false) out.alwaysThinkingEnabled = false
  return out
}

export const ULTRATHINK_PREFIX = 'Ultrathink:\n'

/** Word-boundary match, so `ultrathinking` does not count. */
export function hasUltrathink(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

export function applyUltrathink(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ULTRATHINK_PREFIX
  if (hasUltrathink(trimmed)) return trimmed
  return `${ULTRATHINK_PREFIX}${trimmed}`
}

/** Removes only the leading marker we wrote — the word elsewhere in the body is the
 *  user's own text and must survive. */
export function stripUltrathink(text: string): string {
  return text.replace(/^Ultrathink:\s*/i, '')
}
