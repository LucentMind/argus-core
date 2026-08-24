import { describe, it, expect } from 'vitest'
import { buildConnectorClientConfigResolver } from '../connectorClientConfig'
import type { ConnectorRegistry } from '../connectors'
import type { SecretStore } from '../secrets'
import type { ConnectorMap } from '../../../shared/connectors'

/**
 * Behavioural coverage for the ClientConfigResolver McpOAuth (Task 5/6) is constructed with —
 * extracted out of main/index.ts (Task 7) specifically so the $secret-resolution and
 * no-clientId branches are reachable from Vitest without an IPC-registration harness. Real
 * McpOAuth wiring (which instance this closure is handed to, the IPC handlers that call
 * authorize/authorizeWithCode) stays end-to-end coverage owned by Task 8; this file only
 * covers the resolver's own logic.
 */

function fakeRegistry(map: ConnectorMap): Pick<ConnectorRegistry, 'get'> {
  return { get: () => map }
}

function fakeSecrets(store: Record<string, string>): Pick<SecretStore, 'resolve'> {
  return { resolve: (name: string) => store[name] ?? null }
}

describe('buildConnectorClientConfigResolver', () => {
  it('returns null for an unknown connector id', () => {
    const resolver = buildConnectorClientConfigResolver({
      registry: fakeRegistry({}),
      secrets: fakeSecrets({})
    })
    expect(resolver('missing')).toBeNull()
  })

  it('resolves a $secret clientSecret reference to plaintext', () => {
    const resolver = buildConnectorClientConfigResolver({
      registry: fakeRegistry({
        slack: {
          kind: 'http',
          enabled: true,
          config: {
            url: 'https://mcp.slack.com/mcp',
            clientId: 'client-123',
            clientSecret: { $secret: 'connector/slack/clientSecret' },
            scopes: 'channels:read',
            redirectUrl: 'http://localhost:8080/callback'
          }
        }
      }),
      secrets: fakeSecrets({ 'connector/slack/clientSecret': 'sekrit' })
    })
    expect(resolver('slack')).toEqual({
      clientId: 'client-123',
      clientSecret: 'sekrit',
      scopes: 'channels:read',
      redirectUrl: 'http://localhost:8080/callback'
    })
  })

  it('yields null (never empty string) when the $secret reference is unresolvable', () => {
    const resolver = buildConnectorClientConfigResolver({
      registry: fakeRegistry({
        slack: {
          kind: 'http',
          enabled: true,
          config: {
            url: 'https://mcp.slack.com/mcp',
            clientId: 'client-123',
            clientSecret: { $secret: 'connector/slack/clientSecret' },
            scopes: '',
            redirectUrl: ''
          }
        }
      }),
      // secret store has nothing under that name — resolve() returns null
      secrets: fakeSecrets({})
    })
    expect(resolver('slack')?.clientSecret).toBeNull()
  })

  it('yields null when clientSecret was never configured (not a $secret ref at all)', () => {
    const resolver = buildConnectorClientConfigResolver({
      registry: fakeRegistry({
        slack: {
          kind: 'http',
          enabled: true,
          config: { url: 'https://mcp.slack.com/mcp', clientId: 'client-123' }
        }
      }),
      secrets: fakeSecrets({})
    })
    expect(resolver('slack')?.clientSecret).toBeNull()
  })

  it('still returns redirectUrl/scopes for a clientId-less (public-client) connector, not null', () => {
    // This is the Rovo shape: no clientId, but a real connector entry. authorize()/refresh()
    // (oauth.ts) read redirectUrl/scopes off this same return value regardless of clientId, so
    // returning null here — rather than only for a truly unknown connector — would silently
    // discard a configured redirectUrl and misroute the connector down the ephemeral-loopback
    // path even when one was set.
    const resolver = buildConnectorClientConfigResolver({
      registry: fakeRegistry({
        rovo: {
          kind: 'http',
          enabled: true,
          config: { url: 'https://mcp.atlassian.com/v1/mcp/authv2', transport: 'http', oauth: true }
        }
      }),
      secrets: fakeSecrets({})
    })
    const cfg = resolver('rovo')
    expect(cfg).not.toBeNull()
    expect(cfg?.clientId).toBe('')
    expect(cfg?.clientSecret).toBeNull()
    // httpConfigSchema defaults: no clientId set means no redirectUrl/scopes configured either
    // in this fixture, but the point under test is the shape — not-null, fields present — not
    // any particular value.
    expect(cfg?.redirectUrl).toBe('')
    expect(cfg?.scopes).toBe('')
  })

  it('reads the registry fresh on every call — a config edit takes effect without rebuilding the resolver', () => {
    const map: ConnectorMap = {
      slack: {
        kind: 'http',
        enabled: true,
        config: { url: 'https://mcp.slack.com/mcp', clientId: 'old-id' }
      }
    }
    const resolver = buildConnectorClientConfigResolver({
      registry: fakeRegistry(map),
      secrets: fakeSecrets({})
    })
    expect(resolver('slack')?.clientId).toBe('old-id')
    // mutate in place, as the watched-registry reload would (the fake's get() always returns
    // the same object reference, same as ConnectorRegistry.get() returning its live cache)
    map.slack.config = { url: 'https://mcp.slack.com/mcp', clientId: 'new-id' }
    expect(resolver('slack')?.clientId).toBe('new-id')
  })
})
