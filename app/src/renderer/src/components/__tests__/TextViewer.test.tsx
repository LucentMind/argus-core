// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TextViewer } from '../TextViewer'
import {
  textDocKey,
  type TextDocOpenOk,
  type TextDocOpenResult,
  type TextDocSearchEvent,
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
let searchHitsCbs: Array<(e: TextDocSearchEvent) => void> = []

beforeEach(() => {
  progressCbs = []
  searchHitsCbs = []
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
      onSearchHits: vi.fn((cb: (e: TextDocSearchEvent) => void) => {
        searchHitsCbs.push(cb)
        return () => {
          searchHitsCbs = searchHitsCbs.filter((c) => c !== cb)
        }
      }),
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

  it('search streams hits; filter mode shows only matching lines; row click exits to context', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const find = await screen.findByPlaceholderText('find in file')
    await userEvent.type(find, 'ERROR')
    await waitFor(() => expect(window.argus.textdoc.search).toHaveBeenCalled())
    const [searchId] = (window.argus.textdoc.search as Mock).mock.calls[0]
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId, hits: [7, 1_234_567], scannedTo: 3_000_000, done: true, capped: false })
      )
    )
    expect(await screen.findByText('2 matches')).toBeInTheDocument()
    await userEvent.click(screen.getByTitle('filter to matches'))
    // filter mode: two rows, numbered by true file line
    expect(document.querySelector('#line-1234567')).toBeInTheDocument()
    await userEvent.click(document.querySelector('#line-1234567')!)
    // exits filter mode, jumps to context: row for the neighbor line materializes
    await waitFor(() => expect(document.querySelector('#line-1234566')).toBeInTheDocument())
  })

  it('does not render the find bar for small (whole-content) files', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 1 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    await screen.findByText('b')
    expect(screen.queryByPlaceholderText('find in file')).not.toBeInTheDocument()
  })

  it('resets find state and cancels the outstanding search when the source switches', async () => {
    const { rerender } = render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const find = await screen.findByPlaceholderText('find in file')
    await userEvent.type(find, 'ERROR')
    await waitFor(() => expect(window.argus.textdoc.search).toHaveBeenCalled())
    const [searchId] = (window.argus.textdoc.search as Mock).mock.calls[0]
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId, hits: [7, 8], scannedTo: 100, done: true, capped: false })
      )
    )
    expect(await screen.findByText('2 matches')).toBeInTheDocument()

    rerender(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 3 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    // the searchId must be invalidated synchronously in the render-phase reset,
    // not just in the post-paint [docKey] effect cleanup: a straggler batch from
    // the OLD file arriving right after the switch must already be dropped, even
    // before the new doc has resolved
    expect(window.argus.textdoc.cancelSearch).toHaveBeenCalledWith(searchId)
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId, hits: [9], scannedTo: 100, done: true, capped: false })
      )
    )
    await screen.findByText('2,000,000 lines')
    // and stray late events must not repopulate the new doc's find bar afterwards either
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId, hits: [10], scannedTo: 100, done: true, capped: false })
      )
    )
    const newFind = screen.getByPlaceholderText('find in file') as HTMLInputElement
    expect(newFind.value).toBe('')
    expect(screen.queryByText(/matches/)).not.toBeInTheDocument()
    // exactly one cancel, from the render-phase reset — the effect cleanup must
    // not issue a redundant cancelSearch('') or double-cancel the same id
    expect(window.argus.textdoc.cancelSearch).toHaveBeenCalledTimes(1)
    expect(window.argus.textdoc.cancelSearch).not.toHaveBeenCalledWith('')
  })

  it('cancels the active search when the viewer unmounts', async () => {
    const { unmount } = render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const find = await screen.findByPlaceholderText('find in file')
    await userEvent.type(find, 'ERROR')
    await waitFor(() => expect(window.argus.textdoc.search).toHaveBeenCalled())
    const [searchId] = (window.argus.textdoc.search as Mock).mock.calls[0]
    unmount()
    expect(window.argus.textdoc.cancelSearch).toHaveBeenCalledWith(searchId)
  })

  it('Ctrl-F focuses the find input', async () => {
    const { container } = render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const find = (await screen.findByPlaceholderText('find in file')) as HTMLInputElement
    find.blur()
    expect(find).not.toHaveFocus()
    const root = container.firstElementChild as HTMLElement
    root.focus()
    await userEvent.keyboard('{Control>}f{/Control}')
    expect(find).toHaveFocus()
  })

  it('capped search resumes with fromLine on the same searchId', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const find = await screen.findByPlaceholderText('find in file')
    await userEvent.type(find, 'ERROR')
    await waitFor(() => expect(window.argus.textdoc.search).toHaveBeenCalled())
    const [searchId] = (window.argus.textdoc.search as Mock).mock.calls[0]
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId, hits: [7], scannedTo: 500, done: false, capped: true })
      )
    )
    expect(await screen.findByText(/1 matches — more on demand/)).toBeInTheDocument()
    // first ↓ lands on the one collected hit (line 7); the second ↓ exhausts
    // the collected hits while still capped, which pulls the next page
    await userEvent.click(screen.getByText('↓'))
    await waitFor(() => expect(document.querySelector('#line-7')).toBeInTheDocument())
    await userEvent.click(screen.getByText('↓'))
    await waitFor(() =>
      expect(window.argus.textdoc.search).toHaveBeenCalledWith(
        searchId,
        { kind: 'evidence', evidenceId: 2 },
        'ERROR',
        expect.objectContaining({ fromLine: 501 })
      )
    )
  })

  it('preserves an active search when re-focusing the same file at a different line', async () => {
    const { rerender } = render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const find = await screen.findByPlaceholderText('find in file')
    await userEvent.type(find, 'ERROR')
    await waitFor(() => expect(window.argus.textdoc.search).toHaveBeenCalledTimes(1))
    const [searchId] = (window.argus.textdoc.search as Mock).mock.calls[0]
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId, hits: [7, 8], scannedTo: 100, done: true, capped: false })
      )
    )
    expect(await screen.findByText('2 matches')).toBeInTheDocument()

    // same source, different focusStart: the viewer reloads the doc (doc goes
    // null then non-null again) but the file itself hasn't changed
    rerender(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={2}
        focusEnd={2}
        onClose={vi.fn()}
      />
    )
    await screen.findByText('3,000,000 lines')
    // give the 300ms debounce window a chance to fire if it (incorrectly) restarted
    await new Promise((r) => setTimeout(r, 350))
    expect(window.argus.textdoc.search).toHaveBeenCalledTimes(1)
    expect(window.argus.textdoc.cancelSearch).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('find in file')).toHaveValue('ERROR')
    expect(screen.getByText('2 matches')).toBeInTheDocument()
  })

  it('Ctrl-F does not leak to a window-level Ctrl-F listener mounted underneath the modal', async () => {
    // simulates ChatPane's own window-level Ctrl/Cmd+F listener, which stays mounted
    // underneath the TextViewer modal (App.tsx renders TextViewer as a sibling overlay).
    // Only the 'f' keydown (not the preceding bare 'Control' keydown, which never
    // matches TextViewer's ctrl+f branch and is expected to bubble normally) matters.
    const outerFKeydowns: KeyboardEvent[] = []
    const outerHandler = (e: KeyboardEvent): void => {
      if (e.key === 'f') outerFKeydowns.push(e)
    }
    window.addEventListener('keydown', outerHandler)
    try {
      render(
        <TextViewer
          source={{ kind: 'evidence', evidenceId: 2 }}
          focusStart={1}
          focusEnd={1}
          onClose={vi.fn()}
        />
      )
      const find = await screen.findByPlaceholderText('find in file')
      // focus must originate from inside the modal for this to exercise bubbling —
      // clicking the find input is the realistic case (it's also where Ctrl-F ends
      // up moving focus to)
      await userEvent.click(find)
      await userEvent.keyboard('{Control>}f{/Control}')
      expect(outerFKeydowns).toHaveLength(0)
    } finally {
      window.removeEventListener('keydown', outerHandler)
    }
  })
})
