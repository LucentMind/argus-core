import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PRESETS,
  SLACK_DEFAULT_SCOPES,
  SLACK_FORM_EXTRAS,
  connectorConfig,
  presetSchema,
  type HttpConnectorConfig
} from '../connectors'

describe('confidential-client config fields', () => {
  it('default to empty so every existing http connector keeps DCR behavior', () => {
    const cfg = connectorConfig<HttpConnectorConfig>('http', { url: 'https://x/mcp' })
    expect(cfg.clientId).toBe('')
    expect(cfg.scopes).toBe('')
    expect(cfg.redirectUrl).toBe('')
    expect(cfg.clientSecret).toBeUndefined()
  })

  it('round-trip a $secret ref in clientSecret', () => {
    const cfg = connectorConfig<HttpConnectorConfig>('http', {
      url: 'https://x/mcp',
      clientId: '123.456',
      clientSecret: { $secret: 'connector/slack/clientSecret' }
    })
    expect(cfg.clientId).toBe('123.456')
    expect(cfg.clientSecret).toEqual({ $secret: 'connector/slack/clientSecret' })
  })
})

describe('SLACK_DEFAULT_SCOPES', () => {
  it('is read-only — nothing that can write to the workspace', () => {
    const scopes = SLACK_DEFAULT_SCOPES.split(' ')
    expect(scopes).toHaveLength(12)
    for (const s of scopes) expect(s).not.toMatch(/:write$/)
    expect(scopes).toContain('channels:history')
    expect(scopes).toContain('search:read.public')
  })
})

describe('SLACK_FORM_EXTRAS', () => {
  it('renders the client secret as a keychain-backed password field', () => {
    expect(SLACK_FORM_EXTRAS.clientSecret.control).toBe('password')
    expect(SLACK_FORM_EXTRAS.clientSecret.sensitive).toBe(true)
  })

  it('sorts after the base http fields, which occupy orders 1-3', () => {
    for (const a of Object.values(SLACK_FORM_EXTRAS)) expect(a.order).toBeGreaterThan(3)
  })

  it('covers exactly the four confidential-client fields', () => {
    expect(Object.keys(SLACK_FORM_EXTRAS).sort()).toEqual([
      'clientId',
      'clientSecret',
      'redirectUrl',
      'scopes'
    ])
  })
})

describe('DEFAULT_PRESETS.slack', () => {
  it('parses and points at Slack hosted MCP server over http (SSE is unsupported)', () => {
    const p = presetSchema.parse(DEFAULT_PRESETS.slack)
    expect(p.displayName).toBe('Slack')
    expect(p.kind).toBe('http')
    const cfg = connectorConfig<HttpConnectorConfig>('http', p.config)
    expect(cfg.url).toBe('https://mcp.slack.com/mcp')
    expect(cfg.transport).toBe('http')
    expect(cfg.oauth).toBe(true)
    expect(cfg.scopes).toBe(SLACK_DEFAULT_SCOPES)
    expect(cfg.redirectUrl).toBe('http://localhost:8080/callback')
  })

  it('leaves clientId/clientSecret unset — the user supplies their own Slack app', () => {
    const cfg = connectorConfig<HttpConnectorConfig>('http', DEFAULT_PRESETS.slack.config)
    expect(cfg.clientId).toBe('')
    expect(cfg.clientSecret).toBeUndefined()
  })
})
