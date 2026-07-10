import { describe, it, expect } from 'vitest'
import {
  connectorsSchema,
  connectorConfig,
  classifyToolName,
  isSecretRef,
  collectSecretRefs,
  resolveSecretRefs,
  CONNECTOR_FORMS,
  ROVO_FORM_EXTRAS,
  ROVO_PRESET,
  type StdioConnectorConfig,
  type HttpConnectorConfig
} from '../connectors'

describe('connectors registry schema', () => {
  it('parses {} to an empty registry', () => {
    expect(connectorsSchema.parse({})).toEqual({})
  })

  it('fills instance defaults and round-trips unknown kinds and keys', () => {
    const m = connectorsSchema.parse({
      rovo: { kind: 'http', config: { url: 'https://x' } },
      weird: { kind: 'future-kind', config: { blob: [1] }, futureKey: true }
    })
    expect(m.rovo.enabled).toBe(true)
    expect(m.weird.kind).toBe('future-kind')
    expect(m.weird.config).toEqual({ blob: [1] })
    expect((m.weird as Record<string, unknown>).futureKey).toBe(true)
  })

  it('keeps the lastDiscovered tool cache', () => {
    const m = connectorsSchema.parse({
      a: {
        kind: 'stdio',
        lastDiscovered: { at: '2026-07-10T00:00:00Z', tools: [{ name: 'get_x', risk: 'low' }] }
      }
    })
    expect(m.a.lastDiscovered?.tools[0]).toMatchObject({ name: 'get_x', risk: 'low' })
  })

  it('connectorConfig validates per kind; unknown kind → {}; invalid → defaults', () => {
    const s = connectorConfig<StdioConnectorConfig>('stdio', { command: 'npx', args: ['-y'] })
    expect(s.command).toBe('npx')
    expect(s.args).toEqual(['-y'])
    expect(s.env).toEqual({})
    const h = connectorConfig<HttpConnectorConfig>('http', { url: 'https://x' })
    expect(h.transport).toBe('http')
    expect(h.oauth).toBe(false)
    expect(connectorConfig('no-such-kind', { anything: 1 })).toEqual({})
    const bad = connectorConfig<HttpConnectorConfig>('http', { url: 42 })
    expect(bad.url).toBe('')
  })
})

describe('classifyToolName (spec 2.5 conventions)', () => {
  it.each([
    ['getJiraIssue', 'low'],
    ['get_ticket', 'low'],
    ['searchJiraIssuesUsingJql', 'low'],
    ['listSprints', 'low'],
    ['readFile', 'low'],
    ['viewBoard', 'low'],
    ['fetchPage', 'low'],
    ['createJiraIssue', 'medium'],
    ['update_case', 'medium'],
    ['addCommentToJiraIssue', 'medium'],
    ['commentOnPage', 'medium'],
    ['editPage', 'medium'],
    ['deleteJiraIssue', 'high'],
    ['transitionJiraIssue', 'high'],
    ['removeWatcher', 'high'],
    ['mergeBranch', 'high'],
    ['frobnicate', 'medium'], // unmatched → MEDIUM (safe default)
    ['gettingStarted', 'medium'], // 'get' must be a whole first word
    ['getRemovedItems', 'high'] // HIGH verbs win anywhere (over-classifying is the safe direction; overridable)
  ])('%s → %s', (name, expected) => {
    expect(classifyToolName(name)).toBe(expected)
  })
})

describe('$secret references', () => {
  it('isSecretRef and collectSecretRefs walk deep', () => {
    expect(isSecretRef({ $secret: 'a' })).toBe(true)
    expect(isSecretRef({ secret: 'a' })).toBe(false)
    expect(isSecretRef('x')).toBe(false)
    const cfg = { env: { TOKEN: { $secret: 't1' } }, headers: [{ $secret: 't2' }], url: 'x' }
    expect(collectSecretRefs(cfg).sort()).toEqual(['t1', 't2'])
  })

  it('resolveSecretRefs substitutes values and reports missing, without mutating', () => {
    const cfg = {
      env: { TOKEN: { $secret: 't1' }, PLAIN: 'v' },
      nested: { k: { $secret: 'gone' } }
    }
    const r = resolveSecretRefs(cfg, (n) => (n === 't1' ? 'sesame' : null))
    expect(r.value).toEqual({ env: { TOKEN: 'sesame', PLAIN: 'v' }, nested: { k: '' } })
    expect(r.missing).toEqual(['gone'])
    expect(cfg.env.TOKEN).toEqual({ $secret: 't1' })
  })
})

describe('forms and preset', () => {
  it('per-kind forms are ordered; only the Rovo extras use sensitive', () => {
    for (const form of Object.values(CONNECTOR_FORMS)) {
      const orders = Object.values(form).map((a) => a.order)
      expect(orders).toEqual([...orders].sort((a, b) => a - b))
      for (const a of Object.values(form)) expect(a.sensitive).toBeFalsy()
    }
    expect(ROVO_FORM_EXTRAS.restApiToken.sensitive).toBe(true)
    expect(ROVO_FORM_EXTRAS.restApiToken.control).toBe('password')
  })

  it('ROVO preset is an http+sse+oauth instance', () => {
    expect(ROVO_PRESET.instanceId).toBe('rovo')
    expect(ROVO_PRESET.instance.kind).toBe('http')
    expect(ROVO_PRESET.instance.preset).toBe('rovo')
    expect(ROVO_PRESET.instance.config.transport).toBe('sse')
    expect(ROVO_PRESET.instance.config.oauth).toBe(true)
    expect(ROVO_PRESET.instance.config.url).toContain('atlassian.com')
  })
})
