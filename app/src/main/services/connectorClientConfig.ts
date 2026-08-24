import type { ConnectorRegistry } from './connectors'
import type { SecretStore } from './secrets'
import {
  connectorConfig,
  resolveSecretRefs,
  SLACK_DEFAULT_SCOPES,
  type HttpConnectorConfig
} from '../../shared/connectors'
import type { ClientConfigResolver } from './oauth'

export interface ConnectorClientConfigDeps {
  registry: Pick<ConnectorRegistry, 'get'>
  secrets: Pick<SecretStore, 'resolve'>
}

/**
 * Builds the `ClientConfigResolver` McpOAuth needs to present a connector's confidential-client
 * credentials (Task 5/6's `clientId`/`clientSecret`/`scopes`/`redirectUrl`). Extracted out of
 * main/index.ts — same convention as `buildJiraScopeResolver` in jiraScopeResolver.ts — so the
 * $secret-resolution and no-clientId behavior below is reachable from Vitest without needing an
 * IPC-registration harness.
 *
 * Calls `deps.registry.get()` fresh on every invocation rather than once at construction time:
 * the registry is file-watched, so an edit to mcp-servers.json must take effect on the very next
 * Authorize click without restarting the app.
 */
export function buildConnectorClientConfigResolver(
  deps: ConnectorClientConfigDeps
): ClientConfigResolver {
  return (id) => {
    const inst = deps.registry.get()[id]
    if (!inst) return null
    const cfg = connectorConfig<HttpConnectorConfig>('http', inst.config)
    // resolveSecretRefs turns a missing/unresolvable $secret ref into '' (and reports the name
    // in `missing`, which nothing here needs); fold that back to null below so a caller never
    // mistakes an empty string for a resolved secret.
    const { value } = resolveSecretRefs(cfg.clientSecret, (n) => deps.secrets.resolve(n))
    // Deliberately NOT `if (!cfg.clientId) return null`: authorize()/refresh() (oauth.ts) read
    // redirectUrl/scopes off this SAME return value regardless of clientId, and only gate the
    // confidential-client path on `cfg?.clientId` being truthy. Returning null here for a
    // clientId-less connector (Rovo, and any future public-client one) would silently discard a
    // configured redirectUrl/scopes and misroute it down the ephemeral-loopback path — the
    // unknown-CONNECTOR case is the only one that should short-circuit.
    return {
      clientId: cfg.clientId,
      clientSecret: typeof value === 'string' && value ? value : null,
      // SLACK_FORM_EXTRAS.scopes carries a `defaultValue` for AnnotatedForm's isDefault
      // comparison ONLY — that value is never written back to config. Clearing the textarea
      // (or whatever reset affordance reads `isDefault`) commits null, deepMerge deletes the
      // key, and connectorConfig() reseeds '' — so an empty scopes field is fully reachable
      // from the UI, not just a hand-edited config file. Passed through as scope: undefined,
      // the SDK's scope-selection strategy falls back FIRST to
      // resourceMetadata.scopes_supported.join(' ') — Slack's full 28-scope set, including
      // canvases:write and files:write. An empty field must never mean "request everything
      // the server advertises", so float it to the read-only evidence set here, where the UI
      // cannot bypass it. Scoped to the slack preset only — a non-slack http connector's ''
      // must keep meaning "let the SDK decide", same as before.
      // Tested with .trim() so a whitespace-only value (e.g. '\n' — see the DraftTextarea
      // onCommit note below) still floors to SLACK_DEFAULT_SCOPES instead of reaching the SDK
      // as `scope=%0A`, which Slack answers with an opaque invalid_scope. The stored/returned
      // value is left untrimmed on the non-floored branch — this only changes what counts as
      // "empty" for the floor decision, not what a real (non-whitespace) scopes string carries.
      scopes: !cfg.scopes?.trim() && inst.preset === 'slack' ? SLACK_DEFAULT_SCOPES : cfg.scopes,
      redirectUrl: cfg.redirectUrl
    }
  }
}
