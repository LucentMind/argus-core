// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TextViewer } from '../TextViewer'

beforeEach(() => {
  window.argus = {
    evidence: {
      read: vi.fn(async () => ({
        relPath: 'evidence/util.ts',
        caseSlug: 'C-1',
        content: 'const a = 1\nconst b = 2\nconst c = 3',
        startLine: 1,
        truncated: false
      })),
      list: vi.fn(async () => [])
    }
  } as never
  // jsdom has no scrollIntoView
  Element.prototype.scrollIntoView = vi.fn()
})

describe('TextViewer', () => {
  it('renders numbered lines with line-N ids and highlights the focus line', async () => {
    const { container } = render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 7 }}
        focusStart={2}
        focusEnd={2}
        onClose={vi.fn()}
      />
    )
    await screen.findByText(/util\.ts/)
    await waitFor(() => expect(container.querySelector('#line-2')).not.toBeNull())
    expect(container.querySelector('#line-2')!.className).toContain('bg-defect/20')
  })

  it('syntax-highlights code files by extension', async () => {
    const { container } = render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 7 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull())
  })

  it('repo mode reads via workspaces.readText and shows the ref chip', async () => {
    window.argus = {
      workspaces: {
        readText: vi.fn(async () => ({
          ok: true,
          repoName: 'myrepo',
          relPath: 'src/a.ts',
          content: 'const a = 1\nconst b = 2',
          startLine: 1,
          truncated: false,
          ref: 'main',
          lang: 'typescript'
        }))
      },
      evidence: { list: vi.fn(async () => []) }
    } as never
    render(
      <TextViewer
        source={{ kind: 'repo', caseSlug: 'C-1', repoName: 'myrepo', relPath: 'src/a.ts' }}
        focusStart={2}
        focusEnd={2}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText('myrepo / src/a.ts')).toBeTruthy()
    expect(screen.getByText('@ main')).toBeTruthy()
  })

  it('repo mode shows the not-linked message', async () => {
    window.argus = {
      workspaces: {
        readText: vi.fn(async () => ({ ok: false, reason: 'repo-not-linked' }))
      },
      evidence: { list: vi.fn(async () => []) }
    } as never
    render(
      <TextViewer
        source={{ kind: 'repo', caseSlug: 'C-1', repoName: 'gone', relPath: 'a.ts' }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText(/not linked/)).toBeTruthy()
  })
})
