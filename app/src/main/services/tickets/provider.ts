import type { JiraCommentInfo } from '../../../shared/jira'
import type { PrCandidate } from '../../../shared/pr'
import type { TicketProviderId } from '../../../shared/ticketRef'
import type { TicketIssueData } from '../../../shared/tickets'

export interface TicketProvider {
  readonly id: TicketProviderId
  getIssue(ref: string): Promise<TicketIssueData>
  getComments(ref: string): Promise<JiraCommentInfo[]>
  postComment(ref: string, markdown: string): Promise<{ url: string }>
  webUrl(ref: string): string
  /**
   * PRs this ticket is linked to. `[]` for Jira — that is a PROVEN dead end, not a gap:
   * every `/rest/dev-status/…` path 401s under the connector's grant and `remotelink`
   * returns [] on tickets that visibly have PRs (spike 2026-07-25). Jira PR discovery
   * stays where it is, in `prSearch`'s title search.
   */
  linkedPrs(ref: string): Promise<PrCandidate[]>
}
