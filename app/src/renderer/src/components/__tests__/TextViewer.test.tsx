// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TextViewer } from '../TextViewer'
import {
  textDocKey,
  type TextDocOpenOk,
  type TextDocOpenResult,
  type TextDocSource
} from '../../../../shared/textdoc'

const UTIL_TS_DOC: TextDocOpenOk = {
  ok: true,
  title: 'C-1 / evidence/util.ts',
  lang: 'typescript',
  ref: null,
  totalLines: 3,
  whole: 'const a = 1\nconst b = 2\nconst c = 3',
  caseSlug: 'C-1',
  relPath: 'evidence/util.ts',
  evidenceId: 7
}

const SMALL_DOC: TextDocOpenOk = {
  ok: true,
  title: 'NAV-1 / evidence/small.log',
  lang: null,
  ref: null,
  totalLines: 3,
  whole: 'a\nb\nc\n'
}

const LARGE_DOC: TextDocOpenOk = {
  ok: true,
  title: 'NAV-1 / evidence/big.log',
  lang: null,
  ref: null,
  totalLines: 3_000_000
}

const LARGE_DOC_B: TextDocOpenOk = {
  ok: true,
  title: 'NAV-1 / evidence/big2.log',
  lang: null,
  ref: null,
  totalLines: 2_000_000
}

let progressCbs: Array<(p: { key: string; fraction: number }) => void> = []

beforeEach(() => {
  progressCbs = []
  window.argus = {
    evidence: {
      list: vi.fn(async () => [])
    },
    textdoc: {
      open: vi.fn(async (source: TextDocSource) => {
        if (source.kind === 'evidence' && source.evidenceId === 1) return SMALL_DOC
        if (source.kind === 'evidence' && source.evidenceId === 2) return LARGE_DOC
        if (source.kind === 'evidence' && source.evidenceId === 3) return LARGE_DOC_B
        return UTIL_TS_DOC
      }),
      lines: vi.fn(async (_s: TextDocSource, from: number, to: number) => ({
        from,
        lines: Array.from({ length: to - from + 1 }, (_, i) => `big line ${from + i}`)
      })),
      search: vi.fn(async () => undefined),
      cancelSearch: vi.fn(async () => undefined),
      onSearchHits: vi.fn(() => () => {}),
      onIndexProgress: vi.fn((cb: (p: { key: string; fraction: number }) => void) => {
        progressCbs.push(cb)
        return () => {
          progressCbs = progressCbs.filter((c) => c !== cb)
        }
      })
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

  it('repo mode reads via textdoc.open and shows the ref chip', async () => {
    window.argus.textdoc.open = vi.fn(async () => ({
      ok: true,
      title: 'myrepo / src/a.ts',
      lang: 'typescript',
      ref: 'main',
      totalLines: 2,
      whole: 'const a = 1\nconst b = 2'
    })) as never
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
    window.argus.textdoc.open = vi.fn(async () => ({
      ok: false,
      reason: 'repo-not-linked'
    })) as never
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

  it('small file renders whole content via HighlightedLines (legacy path)', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 1 }}
        focusStart={2}
        focusEnd={2}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText('b')).toBeInTheDocument()
  })

  it('large file renders a virtual list and shows the line count', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1_500_000}
        focusEnd={1_500_002}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText('3,000,000 lines')).toBeInTheDocument()
    // no fixed-window chip anymore
    expect(screen.queryByText(/showing lines near/)).not.toBeInTheDocument()
  })

  it('jump-to-line input scrolls the list', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const jump = await screen.findByPlaceholderText('go to line')
    await userEvent.type(jump, '2500000{Enter}')
    // the row for 2,500,000 becomes the scroll target — its id appears
    await waitFor(() => expect(document.querySelector('#line-2500000')).toBeInTheDocument())
  })

  it('clears the indexing chip when the source switches', async () => {
    const { rerender } = render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    await screen.findByText('3,000,000 lines')
    act(() => progressCbs.forEach((cb) => cb({ key: 'e:2', fraction: 0.42 })))
    expect(screen.getByText('indexing… 42%')).toBeInTheDocument()
    // switching to another source must drop A's stale chip immediately, before any B events
    rerender(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 3 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByText(/indexing…/)).not.toBeInTheDocument()
    await screen.findByText('2,000,000 lines')
    expect(screen.queryByText(/indexing…/)).not.toBeInTheDocument()
  })

  it('ignores a stale open response after the source switches', async () => {
    const pending = new Map<string, (r: TextDocOpenResult) => void>()
    window.argus.textdoc.open = vi.fn(
      (source: TextDocSource) =>
        new Promise<TextDocOpenResult>((resolve) => pending.set(textDocKey(source), resolve))
    ) as never
    const { rerender } = render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    rerender(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 3 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    // B resolves first — the viewer shows B
    await act(async () => pending.get('e:3')!(LARGE_DOC_B))
    expect(await screen.findByText('NAV-1 / evidence/big2.log')).toBeInTheDocument()
    // A's late resolution must be dropped: no doc/title/scrollTarget from A
    await act(async () => pending.get('e:2')!(LARGE_DOC))
    expect(screen.getByText('NAV-1 / evidence/big2.log')).toBeInTheDocument()
    expect(screen.queryByText('NAV-1 / evidence/big.log')).not.toBeInTheDocument()
  })
})
