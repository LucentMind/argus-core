/**
 * The New Case dialog's Jira-key fields historically took a bare issue key
 * (PROJ-1234). Pasting a full "Copy link" URL from Jira silently broke them —
 * the whole URL was sent to the Jira REST API and 404'd. This recognizes the
 * one link shape Jira actually produces (`/browse/<KEY>`) and extracts the
 * key; anything else passes through unchanged so it falls into the same
 * "not found on Jira" error path a bad bare key already takes.
 */
const BROWSE_URL = /^https?:\/\/[^/\s]+\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/i

export function parseJiraKeyInput(input: string): string {
  const trimmed = input.trim()
  const match = BROWSE_URL.exec(trimmed)
  return match ? match[1] : trimmed
}
