// Jira Cloud REST client — UI-native flows only (New Case / Refresh / Health).
// The agent never calls this; its Jira access is the Rovo MCP connector.
import fs from 'node:fs'
import {
  connectorConfig,
  isSecretRef,
  type ConnectorMap,
  type HttpConnectorConfig
} from '../../shared/connectors'
import type { AtlassianErrorCode, JiraAttachmentInfo, JiraIssuePreview } from '../../shared/jira'
import { adfToMarkdown } from './adf'

export class AtlassianError extends Error {
  constructor(
    public code: AtlassianErrorCode,
    message: string,
    public instanceId?: string
  ) {
    super(message)
    this.name = 'AtlassianError'
  }
}

export interface AtlassianCreds {
  instanceId: string
  siteUrl: string // no trailing slash
  token: string
}

/** Find the rovo-preset connector and resolve its REST credentials. */
export function resolveAtlassianCreds(
  connectors: ConnectorMap,
  resolveSecret: (name: string) => string | null
): AtlassianCreds {
  const entry = Object.entries(connectors).find(([, inst]) => inst.preset === 'rovo')
  if (!entry)
    throw new AtlassianError(
      'not-configured',
      'No Atlassian connector configured — add the Atlassian Rovo preset in Settings → Connectors.'
    )
  const [instanceId, inst] = entry
  const cfg = connectorConfig<HttpConnectorConfig>('http', inst.config)
  const siteUrl = (cfg.siteUrl ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(siteUrl))
    throw new AtlassianError(
      'no-site-url',
      `Connector "${instanceId}" has no Site URL — set it in Settings → Connectors.`,
      instanceId
    )
  const token = isSecretRef(cfg.apiToken) ? resolveSecret(cfg.apiToken.$secret) : null
  if (!token)
    throw new AtlassianError(
      'no-token',
      `Connector "${instanceId}" has no Atlassian API token — set it in Settings → Connectors.`,
      instanceId
    )
  return { instanceId, siteUrl, token }
}

export interface JiraIssueData {
  preview: JiraIssuePreview
  descriptionMarkdown: string
  raw: unknown
}

const REST_TIMEOUT_MS = 15000
const ISSUE_FIELDS = 'summary,description,status,labels,reporter,created,updated,attachment'

export class AtlassianClient {
  constructor(
    private creds: () => AtlassianCreds,
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = REST_TIMEOUT_MS
  ) {}

  private async request(pathAndQuery: string): Promise<Response> {
    const { instanceId, siteUrl, token } = this.creds()
    let res: Response
    try {
      res = await this.fetchImpl(`${siteUrl}${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'follow', // undici drops Authorization on cross-origin redirects (attachment CDN)
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (err) {
      throw new AtlassianError(
        'network',
        `Atlassian request failed: ${(err as Error).message}`,
        instanceId
      )
    }
    if (res.status === 401 || res.status === 403)
      throw new AtlassianError(
        'auth',
        `Atlassian rejected the API token (HTTP ${res.status}) — check the token and Site URL on the connector.`,
        instanceId
      )
    if (res.status === 404) throw new AtlassianError('not-found', 'Not found on Jira', instanceId)
    if (!res.ok)
      throw new AtlassianError('http', `Atlassian returned HTTP ${res.status}`, instanceId)
    return res
  }

  async getIssue(key: string): Promise<JiraIssueData> {
    const res = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`
    )
    const raw = (await res.json()) as { key?: string; fields?: Record<string, unknown> }
    const f = raw.fields ?? {}
    const attachments: JiraAttachmentInfo[] = (
      (f.attachment as Array<Record<string, unknown>>) ?? []
    ).map((a) => ({
      id: String(a.id ?? ''),
      filename: String(a.filename ?? 'attachment'),
      size: Number(a.size ?? 0),
      mimeType: String(a.mimeType ?? ''),
      createdAt: String(a.created ?? '')
    }))
    const preview: JiraIssuePreview = {
      key: String(raw.key ?? key),
      summary: String(f.summary ?? ''),
      status: String((f.status as { name?: string } | undefined)?.name ?? ''),
      labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
      reporter: (f.reporter as { displayName?: string } | undefined)?.displayName ?? null,
      created: String(f.created ?? ''),
      updated: String(f.updated ?? ''),
      attachments
    }
    return { preview, descriptionMarkdown: adfToMarkdown(f.description), raw }
  }

  /** Downloads attachment bytes to destPath (follows Jira's redirect to the media host). */
  async downloadAttachment(id: string, destPath: string): Promise<void> {
    const res = await this.request(`/rest/api/3/attachment/content/${encodeURIComponent(id)}`)
    fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
  }

  /** Cheap auth probe for the Health page. */
  async myself(): Promise<{ displayName: string }> {
    const res = await this.request('/rest/api/3/myself')
    const raw = (await res.json()) as { displayName?: string }
    return { displayName: raw.displayName ?? '(unknown)' }
  }
}
