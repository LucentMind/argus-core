import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  PolicyService,
  applyPolicy,
  defaultPolicyPath,
  lockedSecretViolation,
  lockedSettingsViolation,
  policyFirstResolver,
  policySecret,
  policyWantsUser,
  readPolicy
} from '../policy'
import { parsePolicy, policyPayload, managedKeys, type PolicyState } from '../../../shared/policy'
import { defaultSettings } from '../../../shared/settings'
import { secretName } from '../../../shared/observabilityProviders'
import { buildObservationExporter } from '../observability/buildExporter'

const KEY_SECRET = secretName('datadog', 'api-key')
const VALID = {
  observability: {
    providers: {
      datadog: {
        enabled: true,
        site: 'datadoghq.eu',
        mlApp: 'argus-org',
        env: 'prod',
        captureContent: false,
        apiKey: 'org-key-1'
      }
    }
  }
}

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-policy-'))
  file = path.join(dir, 'policy.json')
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})
const write = (data: unknown): void =>
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
const stateOf = (data: unknown): PolicyState => {
  write(data)
  return readPolicy(file)
}

describe('policy file location', () => {
  it('ARGUS_POLICY_FILE wins; else the OS machine path', () => {
    expect(defaultPolicyPath({ ARGUS_POLICY_FILE: '/x/p.json' }, 'darwin')).toBe('/x/p.json')
    expect(defaultPolicyPath({}, 'darwin')).toBe('/Library/Application Support/Argus/policy.json')
    expect(defaultPolicyPath({ ProgramData: 'D:\\PD' }, 'win32')).toBe('D:\\PD\\Argus\\policy.json')
    expect(defaultPolicyPath({}, 'win32')).toBe('C:\\ProgramData\\Argus\\policy.json')
  })
})

describe('readPolicy', () => {
  it('missing file = no policy, no error', () => {
    const s = readPolicy(file)
    expect(s.present).toBe(false)
    expect(s.errors).toEqual([])
    expect(s.policy.observability.providers).toEqual({})
  })

  it('a valid file manages the datadog block (with defaults)', () => {
    const s = stateOf(VALID)
    expect(s.present).toBe(true)
    expect(s.errors).toEqual([])
    expect(s.policy.observability.providers.datadog).toEqual({
      block: { ...VALID.observability.providers.datadog, identifyUser: false },
      error: null
    })
  })

  it('a BOM is tolerated', () => {
    expect(stateOf('\ufeff' + JSON.stringify(VALID)).errors).toEqual([])
  })

  it('invalid JSON: present, nothing managed, an error', () => {
    const s = stateOf('{ not json')
    expect(s.present).toBe(true)
    expect(s.policy.observability.providers).toEqual({})
    expect(s.errors[0]).toMatch(/not valid JSON/)
  })

  it('an invalid provider block fails closed: locked off, with the error', () => {
    const s = stateOf({
      observability: { providers: { datadog: { enabled: true, site: 'nope', apiKey: 'k' } } }
    })
    expect(s.policy.observability.providers.datadog).toMatchObject({
      block: { enabled: false },
      error: expect.stringMatching(/datadog.*site/)
    })
    expect(s.errors).toHaveLength(1)
  })

  it('unknown keys are errors (strict), never silently ignored', () => {
    const typo = parsePolicy({
      observability: { providers: { datadog: { enabled: true, apikey: 'k' } } }
    })
    expect(typo.policy.observability.providers.datadog?.block).toEqual({ enabled: false })
    expect(typo.errors[0]).toMatch(/apikey/)
    expect(parsePolicy({ telemetry: {} }).errors).toEqual(['policy: unknown key "telemetry"'])
    expect(parsePolicy({ observability: { providers: { otlp: {} } } }).errors[0]).toMatch(
      /otlp.*cannot be managed/
    )
    expect(parsePolicy([]).errors[0]).toMatch(/JSON object/)
  })

  it('intakeUrl must be an http(s) URL', () => {
    const bad = parsePolicy({
      observability: { providers: { datadog: { apiKey: 'k', intakeUrl: 'file:///etc' } } }
    })
    expect(bad.errors).toHaveLength(1)
    const good = parsePolicy({
      observability: { providers: { datadog: { apiKey: 'k', intakeUrl: 'http://127.0.0.1:9' } } }
    })
    expect(good.errors).toEqual([])
  })
})

describe('merge', () => {
  it('policy keys win over user settings; untouched user keys survive', () => {
    const user = defaultSettings()
    user.observability.providers.datadog = {
      ...user.observability.providers.datadog,
      enabled: false,
      site: 'datadoghq.com',
      mlApp: 'mine',
      env: 'dev',
      captureContent: true
    }
    const state = stateOf({
      observability: { providers: { datadog: { site: 'datadoghq.eu', apiKey: 'k' } } }
    })
    const eff = applyPolicy(user, state).observability.providers.datadog as Record<string, unknown>
    expect(eff).toMatchObject({
      enabled: true, // the block's default
      site: 'datadoghq.eu',
      mlApp: 'mine',
      env: 'dev',
      captureContent: true
    })
    expect(eff.apiKey).toBeUndefined() // the key never enters the settings object
    expect(eff.identifyUser).toBeUndefined()
    // Other providers untouched.
    expect(applyPolicy(user, state).observability.providers.otlp).toBe(
      user.observability.providers.otlp
    )
  })

  it('no policy returns the settings object unchanged', () => {
    const s = defaultSettings()
    expect(applyPolicy(s, readPolicy(file))).toBe(s)
  })

  it('identifyUser adds userLogin only when the login is known', () => {
    const state = stateOf({
      observability: { providers: { datadog: { apiKey: 'k', identifyUser: true } } }
    })
    expect(policyWantsUser(state)).toBe(true)
    const without = applyPolicy(defaultSettings(), state)
    expect(
      (without.observability.providers.datadog as Record<string, unknown>).userLogin
    ).toBeUndefined()
    const withLogin = applyPolicy(defaultSettings(), state, { userLogin: 'octocat' })
    expect((withLogin.observability.providers.datadog as Record<string, unknown>).userLogin).toBe(
      'octocat'
    )
    expect(policyWantsUser(stateOf(VALID))).toBe(false)
  })

  it('the policy key wins over the secret store', () => {
    const state = stateOf(VALID)
    const store = (n: string): string | null => (n === KEY_SECRET ? 'user-key' : 'other')
    const resolve = policyFirstResolver(() => state, store)
    expect(resolve(KEY_SECRET)).toBe('org-key-1')
    expect(resolve(secretName('otlp', 'authorization'))).toBe('other')
    expect(policySecret(state, KEY_SECRET)).toBe('org-key-1')
    // No policy key → the store.
    const noKey = stateOf({ observability: { providers: { datadog: { enabled: false } } } })
    expect(policyFirstResolver(() => noKey, store)(KEY_SECRET)).toBe('user-key')
  })

  it('end to end: the merged settings and resolver build a datadog sink with no user setting', async () => {
    const state = stateOf(VALID)
    const built = buildObservationExporter(
      applyPolicy(defaultSettings(), state),
      policyFirstResolver(
        () => state,
        () => null
      ),
      { installId: 'i', appVersion: '1' }
    )
    try {
      expect(built.enabled).toEqual([{ id: 'datadog', label: 'Datadog LLM Observability' }])
    } finally {
      await built.exporter?.shutdown()
      for (const s of Object.values(built.sinks)) await s?.shutdown()
    }
  })

  it('an invalid block keeps the provider off even when the user enabled it', () => {
    const user = defaultSettings()
    user.observability.providers.datadog.enabled = true
    const state = stateOf({ observability: { providers: { datadog: { site: 'bad' } } } })
    expect(applyPolicy(user, state).observability.providers.datadog.enabled).toBe(false)
  })
})

describe('locks', () => {
  it('a write to a locked key is rejected; unmanaged keys and other providers are allowed', () => {
    const state = stateOf({
      observability: { providers: { datadog: { site: 'datadoghq.eu', apiKey: 'k' } } }
    })
    const p = (datadog: unknown): unknown => ({ observability: { providers: { datadog } } })
    expect(lockedSettingsViolation(p({ enabled: false }), state)).toMatch(/datadog\.enabled/)
    expect(lockedSettingsViolation(p({ site: 'datadoghq.com' }), state)).toMatch(/datadog\.site/)
    expect(lockedSettingsViolation(p(null), state)).toMatch(/managed/)
    expect(lockedSettingsViolation(p({ env: 'dev' }), state)).toBeNull() // not in the policy
    expect(
      lockedSettingsViolation({ observability: { providers: { otlp: { enabled: true } } } }, state)
    ).toBeNull()
    expect(lockedSettingsViolation({ general: { theme: 'dark' } }, state)).toBeNull()
    expect(lockedSettingsViolation(p({ enabled: false }), readPolicy(path.join(dir, 'x')))).toBe(
      null
    )
  })

  it('a policy-supplied secret cannot be set or deleted by the user', () => {
    const state = stateOf(VALID)
    expect(lockedSecretViolation(KEY_SECRET, state)).toMatch(/managed/)
    expect(lockedSecretViolation(secretName('otlp', 'authorization'), state)).toBeNull()
    const noKey = stateOf({ observability: { providers: { datadog: { enabled: true } } } })
    expect(lockedSecretViolation(KEY_SECRET, noKey)).toBeNull()
  })

  it('managedKeys: enabled always, the secret by its descriptor key, non-field keys excluded', () => {
    expect(
      managedKeys('datadog', {
        enabled: true,
        site: 'x',
        apiKey: 'k',
        intakeUrl: 'u',
        identifyUser: false
      })
    ).toEqual(['enabled', 'site', 'api-key'])
  })
})

describe('payload', () => {
  it('carries managed keys and values but never the key or the intake URL', () => {
    const state = stateOf({
      observability: {
        providers: {
          datadog: { ...VALID.observability.providers.datadog, intakeUrl: 'http://relay:1' }
        }
      }
    })
    const p = policyPayload(state)
    expect(p.present).toBe(true)
    expect(p.observability.datadog).toEqual({
      managed: ['enabled', 'site', 'mlApp', 'env', 'captureContent', 'api-key'],
      values: {
        enabled: true,
        site: 'datadoghq.eu',
        mlApp: 'argus-org',
        env: 'prod',
        captureContent: false
      },
      identifyUser: false,
      customIntake: true,
      error: null
    })
    const text = JSON.stringify(p)
    expect(text).not.toContain('org-key-1')
    expect(text).not.toContain('relay:1')
  })
})

describe('PolicyService', () => {
  it('re-reads on change: rotation, then deletion', async () => {
    write(VALID)
    const svc = new PolicyService(file, 20)
    let changes = 0
    svc.onChange(() => changes++)
    try {
      expect(policySecret(svc.get(), KEY_SECRET)).toBe('org-key-1')
      write({
        observability: {
          providers: {
            datadog: { ...VALID.observability.providers.datadog, apiKey: 'org-key-2' }
          }
        }
      })
      await waitFor(() => policySecret(svc.get(), KEY_SECRET) === 'org-key-2', 15_000)
      expect(changes).toBe(1)
      fs.rmSync(file)
      await waitFor(() => !svc.get().present, 15_000)
      expect(svc.get().policy.observability.providers).toEqual({})
      expect(changes).toBe(2)
    } finally {
      svc.close()
    }
  })

  it('picks up a file created after start', async () => {
    const svc = new PolicyService(file, 20)
    svc.onChange(() => {})
    try {
      expect(svc.get().present).toBe(false)
      write(VALID)
      // fs.watchFile's interval is a floor, not a promise: under full-suite CPU load a 20 ms
      // poll can land seconds late.
      await waitFor(() => svc.get().present, 15_000)
    } finally {
      svc.close()
    }
  })

  it('reload without a change does not notify', () => {
    write(VALID)
    const svc = new PolicyService(file, 20)
    let changes = 0
    svc.onChange(() => changes++)
    svc.reload()
    svc.reload()
    svc.close()
    expect(changes).toBe(0)
  })
})

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
