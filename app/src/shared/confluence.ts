// Confluence REST types shared by main and renderer (Wave 3 Part 3).
// Like Jira (shared/jira.ts), the REST client is UI-native only — the agent's
// Confluence access stays Rovo MCP.

export interface ConfluenceSpace {
  key: string
  name: string
  homepageId: string
}

export interface ConfluencePageNode {
  id: string
  title: string
  version: number
  /** ISO timestamp of the page's own last modification; null when the API omits it. */
  lastModified: string | null
  hasChildren: boolean
}

export interface ConfluencePageContent {
  node: ConfluencePageNode
  url: string
  markdown: string
}
