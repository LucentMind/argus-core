import type { JiraCommentInfo } from '../../../shared/jira'
import type { PrCandidate } from '../../../shared/pr'
import type { TicketIssueData } from '../../../shared/tickets'
import type { AtlassianClientLike } from '../jiraCases'
import type { TicketProvider } from './provider'

export interface JiraProviderDeps {
  client: AtlassianClientLike
  /** The connector's site URL, e.g. `https://argus88.atlassian.net`. */
  site: () => string
  /** Posting goes through the Rovo MCP connector, which lives above this seam. */
  postComment: (key: string, markdown: string) => Promise<void>
}

export function createJiraProvider(deps: JiraProviderDeps): TicketProvider {
  const webUrl = (ref: string): string => `${deps.site().replace(/\/+$/, '')}/browse/${ref}`
  return {
    id: 'jira',

    async getIssue(ref: string): Promise<TicketIssueData> {
      const data = await deps.client.getIssue(ref)
      // Behaviour is identical to today's path: the only additions are the two new fields.
      return {
        preview: { ...data.preview, provider: 'jira', url: webUrl(data.preview.key) },
        descriptionMarkdown: data.descriptionMarkdown,
        raw: data.raw
      }
    },

    getComments(ref: string): Promise<JiraCommentInfo[]> {
      return deps.client.getComments(ref)
    },

    async postComment(ref: string, markdown: string): Promise<{ url: string }> {
      await deps.postComment(ref, markdown)
      return { url: webUrl(ref) }
    },

    webUrl,

    // See the interface comment: dev-status 401s and remotelink returns [] on tickets that
    // visibly have PRs. Jira PR discovery stays in prSearch's title search.
    async linkedPrs(): Promise<PrCandidate[]> {
      return []
    }
  }
}
