import type { TicketProviderId } from './ticketRef'

export const UNASSIGNED_DOMAIN = 'unassigned'

const JIRA_KEY = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/

/** Spec §4.3: Jira project key → GitHub owner/repo → first workspace basename → 'unassigned'.
 *  Stamped on each attribution row at judge time, so later case edits never rewrite history. */
export function deriveCaseDomain(
  c: { ticketProvider: TicketProviderId; jiraKey: string | null },
  workspaces: { path: string }[]
): string {
  if (c.jiraKey) {
    if (c.ticketProvider === 'jira') {
      const m = JIRA_KEY.exec(c.jiraKey.trim())
      if (m) return m[1].toUpperCase()
    } else if (c.ticketProvider === 'github') {
      const i = c.jiraKey.indexOf('#')
      const repo = (i === -1 ? c.jiraKey : c.jiraKey.slice(0, i)).trim()
      if (repo.includes('/')) return repo
    }
  }
  const first = workspaces[0]?.path
  if (first) {
    const parts = first.split(/[\\/]+/).filter(Boolean)
    const base = parts[parts.length - 1]
    if (base) return base
  }
  return UNASSIGNED_DOMAIN
}
