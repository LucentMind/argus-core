import { describe, it, expect, vi } from 'vitest'
import { createJiraProvider } from '../jiraProvider'
import { providerFor } from '../provider'
import { createGithubProvider } from '../githubProvider'

const preview = {
  key: 'KAN-17',
  summary: 'Tile 403s',
  status: 'In Progress',
  priority: 'High',
  labels: ['nav'],
  reporter: 'jhan',
  created: '2026-08-01T00:00:00Z',
  updated: '2026-08-02T00:00:00Z',
  attachments: [],
  cloneLinks: []
}

const deps = (): Parameters<typeof createJiraProvider>[0] => ({
  client: {
    getIssue: vi.fn(async () => ({ preview, descriptionMarkdown: 'desc', raw: { k: 1 } })),
    getComments: vi.fn(async () => []),
    downloadAttachment: vi.fn(async () => undefined)
  },
  site: () => 'https://argus88.atlassian.net',
  postComment: vi.fn(async () => undefined)
})

describe('jiraProvider', () => {
  it('tags the preview with its provider and site URL, preserving every other field', async () => {
    const { preview: p } = await createJiraProvider(deps()).getIssue('KAN-17')
    expect(p.provider).toBe('jira')
    expect(p.url).toBe('https://argus88.atlassian.net/browse/KAN-17')
    expect(p.key).toBe('KAN-17')
    expect(p.priority).toBe('High')
    expect(p.status).toBe('In Progress')
  })

  it('reports no linked PRs — dev-status is a proven dead end, not a gap', async () => {
    expect(await createJiraProvider(deps()).linkedPrs('KAN-17')).toEqual([])
  })

  it('builds a browse URL', () => {
    expect(createJiraProvider(deps()).webUrl('KAN-17')).toBe(
      'https://argus88.atlassian.net/browse/KAN-17'
    )
  })
})

describe('providerFor', () => {
  it('selects by id, never by ref shape', () => {
    const registry = { jira: createJiraProvider(deps()), github: createGithubProvider({}) }
    expect(providerFor('github', registry).id).toBe('github')
    expect(providerFor('jira', registry).id).toBe('jira')
  })
})
