import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings } from '../../shared/settings'
import { secretName } from '../../shared/observabilityProviders'
import {
  EMPTY_POLICY,
  POLICY_NON_FIELD_KEYS,
  POLICY_SECRET_KEYS,
  managedKeys,
  parsePolicy,
  type ManageableProviderId,
  type PolicyState,
  type ProviderPolicy
} from '../../shared/policy'

/**
 * The OS-standard machine-level location of the org policy: outside ARGUS_HOME (a user can point
 * ARGUS_HOME anywhere) and writable only by an administrator. `ARGUS_POLICY_FILE` overrides it
 * (tests and gates).
 */
export function defaultPolicyPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (env.ARGUS_POLICY_FILE) return env.ARGUS_POLICY_FILE
  if (platform === 'win32')
    return path.win32.join(env.ProgramData || 'C:\\ProgramData', 'Argus', 'policy.json')
  if (platform === 'darwin') return '/Library/Application Support/Argus/policy.json'
  return '/etc/argus/policy.json'
}

/** Read and parse the policy file. Missing file = no policy; never throws. */
export function readPolicy(file: string): PolicyState {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { path: file, present: false, policy: EMPTY_POLICY, errors: [] }
    return {
      path: file,
      present: true,
      policy: EMPTY_POLICY,
      errors: [`policy: cannot read ${file}: ${(err as Error).message}`]
    }
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    return {
      path: file,
      present: true,
      policy: EMPTY_POLICY,
      errors: [`policy: ${file} is not valid JSON: ${(err as Error).message}`]
    }
  }
  const { policy, errors } = parsePolicy(data)
  return { path: file, present: true, policy, errors }
}

/**
 * How often the file is re-read. A plain timer that re-reads and compares the PARSED result, not
 * `fs.watch` (the policy directory often does not exist until IT creates it) and not
 * `fs.watchFile`: watchFile takes its baseline stat asynchronously on the libuv thread pool, so a
 * file created while that pool is busy can become the baseline itself and never fire a change
 * (seen as a flaky test under full-suite load). Reading one small file every 2 s is negligible,
 * and survives create / delete / atomic replace alike.
 */
const POLL_MS = 2_000

/**
 * Loads the policy once at construction and re-reads it whenever the file changes, so IT can
 * rotate a key (or remove the policy) without users restarting.
 */
export class PolicyService {
  private state: PolicyState
  private listeners = new Set<() => void>()
  private last: string
  private timer: NodeJS.Timeout | null = null

  constructor(
    readonly file: string = defaultPolicyPath(),
    private pollMs: number = POLL_MS
  ) {
    this.state = readPolicy(file)
    this.last = JSON.stringify(this.state)
  }

  get(): PolicyState {
    return this.state
  }

  /** Re-read now; notifies when the parsed result changed. */
  reload(): void {
    const next = readPolicy(this.file)
    const key = JSON.stringify(next)
    if (key === this.last) return
    this.last = key
    this.state = next
    for (const cb of this.listeners) cb()
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    if (!this.timer) {
      this.timer = setInterval(() => this.reload(), this.pollMs)
      this.timer.unref?.() // never keeps the app (or a test worker) alive
    }
    return () => this.listeners.delete(cb)
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.listeners.clear()
  }
}

const entries = (state: PolicyState): [ManageableProviderId, ProviderPolicy][] =>
  Object.entries(state.policy.observability.providers) as [ManageableProviderId, ProviderPolicy][]

/**
 * The settings the observability exporter runs on: user settings with every policy block laid
 * over its provider (`{...user, ...policy}`; policy keys always win). Secrets and `identifyUser`
 * are not settings fields and are not copied; `intakeUrl` is (the adapter reads it from its
 * config), and `userLogin` is added when the policy asks to identify the user and the login is
 * known.
 */
export function applyPolicy(
  settings: AppSettings,
  state: PolicyState,
  extras: { userLogin?: string | null } = {}
): AppSettings {
  const managed = entries(state)
  if (managed.length === 0) return settings
  const providers = { ...settings.observability.providers } as Record<
    string,
    Record<string, unknown>
  >
  for (const [id, p] of managed) {
    const overlay: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(p.block)) {
      if (POLICY_SECRET_KEYS[id]?.[k]) continue
      if (k === 'identifyUser') continue
      overlay[k] = v
    }
    if (p.block.identifyUser === true && extras.userLogin) overlay.userLogin = extras.userLogin
    providers[id] = { ...(providers[id] ?? {}), ...overlay }
  }
  return {
    ...settings,
    observability: {
      ...settings.observability,
      providers: providers as AppSettings['observability']['providers']
    }
  }
}

/** A secret the policy supplies, by its FULL store name; null when the policy has none. */
export function policySecret(state: PolicyState, name: string): string | null {
  for (const [id, p] of entries(state)) {
    for (const [policyKey, secretKey] of Object.entries(POLICY_SECRET_KEYS[id] ?? {})) {
      const v = p.block[policyKey]
      if (secretName(id, secretKey) === name && typeof v === 'string' && v) return v
    }
  }
  return null
}

/** Secret resolution with the policy first, then the user's encrypted store. */
export function policyFirstResolver(
  state: () => PolicyState,
  store: (name: string) => string | null
): (name: string) => string | null {
  return (name) => policySecret(state(), name) ?? store(name)
}

/** True when the policy asks for the user's identity on the telemetry. */
export function policyWantsUser(state: PolicyState): boolean {
  return entries(state).some(([, p]) => p.block.identifyUser === true)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Why a settings patch must be refused: it writes a key the policy locks. The renderer disables
 * those controls; this is the main-process half, so a stale window or a hand-crafted IPC call
 * cannot change a managed value either. null when the patch is allowed.
 */
export function lockedSettingsViolation(patch: unknown, state: PolicyState): string | null {
  if (!isObj(patch) || !isObj(patch.observability) || !isObj(patch.observability.providers))
    return null
  const providers = patch.observability.providers
  for (const [id, p] of entries(state)) {
    const written = providers[id]
    if (written === undefined) continue
    const locked = new Set(managedKeys(id, p.block))
    // Replacing the whole block (null / non-object) touches every locked key.
    if (!isObj(written)) return `observability.providers.${id} is managed by your organization`
    for (const k of Object.keys(written))
      if (locked.has(k) && !POLICY_NON_FIELD_KEYS.has(k))
        return `observability.providers.${id}.${k} is managed by your organization`
  }
  return null
}

/** Why a secret write/delete must be refused: the policy supplies that secret. */
export function lockedSecretViolation(name: string, state: PolicyState): string | null {
  for (const [id, p] of entries(state)) {
    for (const [policyKey, secretKey] of Object.entries(POLICY_SECRET_KEYS[id] ?? {})) {
      if (secretName(id, secretKey) === name && p.block[policyKey] !== undefined)
        return `${name} is managed by your organization`
    }
  }
  return null
}
