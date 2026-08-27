import type { JiraIssuePreview } from './jira'
import type { TicketProviderId } from './ticketRef'

/**
 * A ticket preview from any provider. Deliberately EXTENDS `JiraIssuePreview` rather than
 * replacing it: `key` keeps holding the provider-native ref, so every existing renderer and
 * main-process consumer keeps working unchanged and this increment adds fields instead of
 * renaming them. The naming debt (`key`, `meta.jira`) is cleared by the deferred rename
 * increment, not here.
 */
export interface TicketPreview extends JiraIssuePreview {
  provider: TicketProviderId
  /** Canonical web URL of the ticket, as the provider reports it. */
  url: string
}

export interface TicketIssueData {
  preview: TicketPreview
  descriptionMarkdown: string
  raw: unknown
}
