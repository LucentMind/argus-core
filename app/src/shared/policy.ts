import { z } from './zodConfig'
import { DATADOG_SITES, type ObservabilityProviderId } from './observabilityProviders'

/**
 * Org policy: a machine-level, read-only JSON file (pushed by MDM or IT) that enables and
 * configures parts of Argus the user cannot change. Scoped to observability today; shaped so
 * other managed blocks can be added beside `observability` later.
 *
 * Validation is per block and strict (an unknown key is an error, so a typo never silently does
 * nothing). A block that fails validation FAILS CLOSED: that provider is locked off, and the error
 * is reported on the `policy` health row. See `docs/observability.md` § Org policy.
 */

const datadogPolicySchema = z.strictObject({
  /** A policy block exists to turn the provider on; `false` locks it off. Default true. */
  enabled: z.boolean().default(true),
  site: z.enum(DATADOG_SITES).optional(),
  mlApp: z.string().optional(),
  env: z.string().optional(),
  captureContent: z.boolean().optional(),
  /** Phase 1 delivery of the Datadog API key. Main-process only: never reaches the renderer,
   *  `settings.json` or the secret store. */
  apiKey: z.string().min(1).optional(),
  /** Base URL that replaces `https://api.<site>` (the phase 2 relay, or a test receiver). */
  intakeUrl: z.url({ protocol: /^https?$/ }).optional(),
  /** Add an `argus.user:<gh login>` tag to everything sent. Default off. */
  identifyUser: z.boolean().default(false)
})
export type DatadogPolicy = z.infer<typeof datadogPolicySchema>

/** One schema per provider a policy can manage. Providers absent here cannot be managed. */
export const PROVIDER_POLICY_SCHEMAS = {
  datadog: datadogPolicySchema
} as const satisfies Partial<Record<ObservabilityProviderId, z.ZodType>>
export type ManageableProviderId = keyof typeof PROVIDER_POLICY_SCHEMAS

/** Policy keys that are NOT settings keys: they configure the adapter some other way. */
export const POLICY_SECRET_KEYS: Partial<Record<ManageableProviderId, Record<string, string>>> = {
  /** policy key → the descriptor's secret key it replaces. */
  datadog: { apiKey: 'api-key' }
}
/** Policy keys that never show up as a settings field (and are not locked as one). */
export const POLICY_NON_FIELD_KEYS = new Set(['apiKey', 'intakeUrl', 'identifyUser'])

export interface ProviderPolicy {
  /** The validated block; for a block that failed validation, `{ enabled: false }`. */
  block: Record<string, unknown>
  /** Validation error of this block (the provider is then locked off). */
  error: string | null
}

export interface Policy {
  observability: { providers: Partial<Record<ManageableProviderId, ProviderPolicy>> }
}

export interface PolicyState {
  /** Where the policy is read from (OS default or `ARGUS_POLICY_FILE`). */
  path: string
  /** A file exists at `path` (readable or not). */
  present: boolean
  policy: Policy
  /** File-level problems (unreadable, not JSON, unknown top-level keys) and every block error. */
  errors: string[]
}

export const EMPTY_POLICY: Policy = { observability: { providers: {} } }

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const issueText = (prefix: string, err: z.ZodError): string =>
  `${prefix}: ${err.issues
    .map((i) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`)
    .join('; ')}`

/**
 * Parse a policy document (already JSON-decoded). Never throws. Structure errors above the
 * provider blocks yield an empty policy plus the error; a bad provider block locks that provider
 * off.
 */
export function parsePolicy(data: unknown): { policy: Policy; errors: string[] } {
  const errors: string[] = []
  const policy: Policy = { observability: { providers: {} } }
  if (!isObj(data)) return { policy, errors: ['policy: the file must contain a JSON object'] }
  for (const k of Object.keys(data))
    if (k !== 'observability') errors.push(`policy: unknown key "${k}"`)
  const obs = data.observability
  if (obs === undefined) return { policy, errors }
  if (!isObj(obs)) return { policy, errors: [...errors, 'policy: observability must be an object'] }
  for (const k of Object.keys(obs))
    if (k !== 'providers') errors.push(`policy: unknown key "observability.${k}"`)
  const providers = obs.providers
  if (providers === undefined) return { policy, errors }
  if (!isObj(providers))
    return { policy, errors: [...errors, 'policy: observability.providers must be an object'] }
  for (const [id, raw] of Object.entries(providers)) {
    if (!(id in PROVIDER_POLICY_SCHEMAS)) {
      errors.push(`policy: provider "${id}" cannot be managed by policy`)
      continue
    }
    const pid = id as ManageableProviderId
    const r = PROVIDER_POLICY_SCHEMAS[pid].safeParse(raw)
    if (r.success) {
      policy.observability.providers[pid] = {
        block: r.data as Record<string, unknown>,
        error: null
      }
    } else {
      const msg = issueText(`policy: observability.providers.${id}`, r.error)
      errors.push(msg)
      policy.observability.providers[pid] = { block: { enabled: false }, error: msg }
    }
  }
  return { policy, errors }
}

/**
 * What the renderer may know about the policy: which provider fields are managed and their
 * values, NEVER a secret. `managed` holds settings keys plus the descriptor's secret keys.
 */
export interface PolicyPayload {
  present: boolean
  path: string
  errors: string[]
  observability: Partial<
    Record<
      ObservabilityProviderId,
      {
        managed: string[]
        values: Record<string, unknown>
        identifyUser: boolean
        /** A custom intake (relay) is configured; the URL itself is not shown. */
        customIntake: boolean
        /** The block failed validation: the provider is locked off. */
        error: string | null
      }
    >
  >
}

/** The settings keys and secret keys a provider's policy block locks. `enabled` always. */
export function managedKeys(id: ManageableProviderId, block: Record<string, unknown>): string[] {
  const keys = new Set<string>(['enabled'])
  for (const k of Object.keys(block)) {
    const secretKey = POLICY_SECRET_KEYS[id]?.[k]
    if (secretKey) keys.add(secretKey)
    else if (!POLICY_NON_FIELD_KEYS.has(k)) keys.add(k)
  }
  return [...keys]
}

export function policyPayload(state: PolicyState): PolicyPayload {
  const observability: PolicyPayload['observability'] = {}
  for (const [id, p] of Object.entries(state.policy.observability.providers) as [
    ManageableProviderId,
    ProviderPolicy
  ][]) {
    const values: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(p.block))
      if (!POLICY_NON_FIELD_KEYS.has(k) && !POLICY_SECRET_KEYS[id]?.[k]) values[k] = v
    observability[id] = {
      managed: managedKeys(id, p.block),
      values,
      identifyUser: p.block.identifyUser === true,
      customIntake: typeof p.block.intakeUrl === 'string',
      error: p.error
    }
  }
  return { present: state.present, path: state.path, errors: state.errors, observability }
}
