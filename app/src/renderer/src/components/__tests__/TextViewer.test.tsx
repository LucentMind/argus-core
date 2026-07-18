// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
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

// search ids are `<docKey>:<channel>:<seq>` (channel `flt`/`fnd`) — these pick
// out the calls on one channel from the shared `search` mock.
function searchCalls(channel: 'flt' | 'fnd'): (Mock['mock']['calls'][number] & string[])[] {
  return (window.argus.textdoc.search as Mock).mock.calls.filter((c) =>
    (c[0] as string).includes(`:${channel}:`)
  ) as never
}
function firstSearchCall(channel: 'flt' | 'fnd'): Mock['mock']['calls'][number] {
  const calls = searchCalls(channel)
  return calls[0]
}
function lastSearchCall(channel: 'flt' | 'fnd'): Mock['mock']['calls'][number] {
  const calls = searchCalls(channel)
  return calls[calls.length - 1]
}

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

  it('loads line content under React StrictMode (page cache survives double-mounted effects)', async () => {
    // the app mounts under StrictMode (main.tsx); dev double-invokes effect
    // setup/cleanup on mount, so a cache disposed in cleanup but owned by
    // useMemo would be reused dead — rows would skeleton forever
    render(
      <StrictMode>
        <TextViewer
          source={{ kind: 'evidence', evidenceId: 2 }}
          focusStart={1}
          focusEnd={1}
          onClose={vi.fn()}
        />
      </StrictMode>
    )
    expect(await screen.findByText('big line 1')).toBeInTheDocument()
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

  it('flags a stale citation pointing beyond EOF and clamps the scroll', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={3_500_000}
        focusEnd={3_500_002}
        onClose={vi.fn()}
      />
    )
    expect(
      await screen.findByText('line 3500000 does not exist — the file ends at line 3000000')
    ).toBeInTheDocument()
    // scroll target clamps to the last line instead of overshooting
    await waitFor(() => expect(document.querySelector('#line-3000000')).toBeInTheDocument())
  })

  it('Ctrl-F focuses the find input even with Shift/CapsLock (key "F")', async () => {
    const { container } = render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    await screen.findByPlaceholderText('find in file')
    const root = container.firstElementChild as HTMLElement
    fireEvent.keyDown(root, { key: 'F', ctrlKey: true, shiftKey: true })
    expect(document.activeElement).toBe(screen.getByPlaceholderText('find in file'))
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

  it('next/prev step through every match sequentially, not from the viewport midpoint', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const find = await screen.findByPlaceholderText('find in file')
    await userEvent.type(find, 'frame')
    await waitFor(() => expect(window.argus.textdoc.search).toHaveBeenCalled())
    const [searchId] = firstSearchCall('fnd')
    expect(searchId).toContain(':fnd:')
    // 111 hits spread across the file (mirrors the real bug report)
    const hits = Array.from({ length: 111 }, (_, i) => (i + 1) * 10)
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId, hits, scannedTo: 3_000_000, done: true, capped: false })
      )
    )
    expect(await screen.findByText('111 matches')).toBeInTheDocument()
    const down = screen.getByRole('button', { name: '↓' })
    // every press must advance exactly one match — the regression pinned the
    // cursor to the (overscan-inflated) viewport midpoint and skipped/looped
    for (let k = 1; k <= 5; k++) {
      await userEvent.click(down)
      expect(await screen.findByText(`${k} / 111 matches`)).toBeInTheDocument()
    }
    // switch into the filtered view — a filter query restarts `find` on its own
    // channel (find now runs AND-ed with the filter), so fresh batches follow
    const filterInput = screen.getByPlaceholderText('filter lines')
    await userEvent.type(filterInput, 'CTX')
    await waitFor(() => expect(searchCalls('fnd').length).toBeGreaterThan(1))
    const [fltId] = lastSearchCall('flt')
    const [fndId2] = lastSearchCall('fnd')
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId: fltId, hits, scannedTo: 3_000_000, done: true, capped: false })
      )
    )
    const findHits2 = [20, 40, 60, 80]
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId: fndId2, hits: findHits2, scannedTo: 3_000_000, done: true, capped: false })
      )
    )
    expect(filterInput).toHaveValue('CTX')
    // VirtualLines is the same DOM node across the branch switch and keeps its
    // old scroll offset, which no longer means anything in the new (smaller)
    // filtered row space — re-seed a known position via jump-to-line (already
    // covered on its own below) before exercising next() from scratch
    const jump = screen.getByPlaceholderText('go to line')
    await userEvent.type(jump, '1{Enter}')
    // the short filtered list is where the old midpoint bug pinned dead-center
    for (let k = 1; k <= 4; k++) {
      await userEvent.click(down)
      expect(await screen.findByText(`${k} / 4 matches`)).toBeInTheDocument()
    }
    // prev walks straight back down
    await userEvent.click(screen.getByRole('button', { name: '↑' }))
    expect(await screen.findByText('3 / 4 matches')).toBeInTheDocument()
    // still filtered throughout
    expect(filterInput).toHaveValue('CTX')
  })

  it('no-wrap: pressing ↓ at the last find hit keeps the label at n / n (no jump back to 1)', async () => {
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
    const [fndId] = firstSearchCall('fnd')
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId: fndId, hits: [10, 20, 30], scannedTo: 3_000_000, done: true, capped: false })
      )
    )
    expect(await screen.findByText('3 matches')).toBeInTheDocument()
    const down = screen.getByRole('button', { name: '↓' })
    for (let k = 1; k <= 3; k++) {
      await userEvent.click(down)
      expect(await screen.findByText(`${k} / 3 matches`)).toBeInTheDocument()
    }
    // one more press past the last hit — the search is done (not capped), so
    // there is nothing more to fetch; the cursor must not wrap back to 1
    await userEvent.click(down)
    expect(await screen.findByText('3 / 3 matches')).toBeInTheDocument()
  })

  it('filter input shows only matching lines; row click no longer exits the filtered view', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const filterInput = await screen.findByPlaceholderText('filter lines')
    await userEvent.type(filterInput, 'ERROR')
    await waitFor(() => expect(window.argus.textdoc.search).toHaveBeenCalled())
    const [fltId] = firstSearchCall('flt')
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({
          searchId: fltId,
          hits: [7, 1_234_567],
          scannedTo: 3_000_000,
          done: true,
          capped: false
        })
      )
    )
    expect(await screen.findByText('2 filtered')).toBeInTheDocument()
    // filtered view: two rows, numbered by true file line
    expect(document.querySelector('#line-7')).toBeInTheDocument()
    expect(document.querySelector('#line-1234567')).toBeInTheDocument()
    await userEvent.click(document.querySelector('#line-1234567')!)
    // the filtered view is input-driven — clicking a row no longer exits it
    expect(document.querySelector('#line-1234567')).toBeInTheDocument()
    expect(document.querySelector('#line-7')).toBeInTheDocument()
    expect(filterInput).toHaveValue('ERROR')
  })

  it('Enter in find input scrolls the filtered view in filter-hit-index space, not file-line space', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1_000_000}
        focusEnd={1_000_000}
        onClose={vi.fn()}
      />
    )
    const filterInput = await screen.findByPlaceholderText('filter lines')
    await userEvent.type(filterInput, 'CTX')
    await waitFor(() => expect(window.argus.textdoc.search).toHaveBeenCalled())
    const [fltId] = firstSearchCall('flt')
    // filter.hits is a wider set that CONTAINS the eventual find hit (subset invariant)
    const filterHits = [5, 7, 1_234_567, 2_000_000]
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId: fltId, hits: filterHits, scannedTo: 3_000_000, done: true, capped: false })
      )
    )
    expect(await screen.findByText('4 filtered')).toBeInTheDocument()

    const find = screen.getByPlaceholderText('find in file')
    await userEvent.type(find, 'ERROR')
    await waitFor(() => expect(searchCalls('fnd').length).toBeGreaterThan(0))
    const [fndId] = firstSearchCall('fnd')
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({
          searchId: fndId,
          hits: [7, 1_234_567],
          scannedTo: 3_000_000,
          done: true,
          capped: false
        })
      )
    )
    expect(await screen.findByText('2 matches')).toBeInTheDocument()

    // currentLine starts at focusStart (1,000,000) — next() lands on the only
    // hit past it: find.hits[1] = 1,234,567, which sits at filter.hits[2]
    await userEvent.type(find, '{Enter}')
    await waitFor(() => expect(document.querySelector('#line-1234567')).toBeInTheDocument())
    const scroller = document.querySelector('.overflow-auto') as HTMLElement
    // filter-hit-index space (row 2), NOT find-hit-index space (row 1) and NOT
    // file-line space (which would be ~24M px)
    const expected = Math.max(0, 2 * 20 - scroller.clientHeight / 2 + 10)
    expect(scroller.scrollTop).toBe(expected)
  })

  it('jump-to-line input stays filtered and scrolls to the nearest filter-hit row', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const filterInput = await screen.findByPlaceholderText('filter lines')
    await userEvent.type(filterInput, 'CTX')
    await waitFor(() => expect(window.argus.textdoc.search).toHaveBeenCalled())
    const [fltId] = firstSearchCall('flt')
    const filterHits = [100, 200, 300, 400_000]
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId: fltId, hits: filterHits, scannedTo: 3_000_000, done: true, capped: false })
      )
    )
    expect(await screen.findByText('4 filtered')).toBeInTheDocument()

    const jump = screen.getByPlaceholderText('go to line')
    // 250 isn't itself a filter hit — nearest ≤ is 200 (index 1)
    await userEvent.type(jump, '250{Enter}')
    await waitFor(() => expect(document.querySelector('#line-200')).toBeInTheDocument())
    // still filtered: the filter query and its rows are untouched
    expect(filterInput).toHaveValue('CTX')
    expect(document.querySelector('#line-100')).toBeInTheDocument()
  })

  it('a find query ANDs with an active filter — the fnd search call carries `filter`', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const filterInput = await screen.findByPlaceholderText('filter lines')
    await userEvent.type(filterInput, 'CTX1')
    await waitFor(() => expect(window.argus.textdoc.search).toHaveBeenCalled())
    const [fltId] = firstSearchCall('flt')
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({
          searchId: fltId,
          hits: [10, 20, 30, 40],
          scannedTo: 3_000_000,
          done: true,
          capped: false
        })
      )
    )
    expect(await screen.findByText('4 filtered')).toBeInTheDocument()

    const find = screen.getByPlaceholderText('find in file')
    await userEvent.type(find, 'info')
    await waitFor(() => expect(searchCalls('fnd').length).toBeGreaterThan(0))
    const fndCall = firstSearchCall('fnd')
    expect(fndCall[3]).toEqual(
      expect.objectContaining({ filter: expect.objectContaining({ query: 'CTX1' }) })
    )

    const [fndId] = fndCall
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId: fndId, hits: [20, 40], scannedTo: 3_000_000, done: true, capped: false })
      )
    )
    expect(await screen.findByText('2 matches')).toBeInTheDocument()

    const down = screen.getByRole('button', { name: '↓' })
    await userEvent.click(down)
    expect(await screen.findByText('1 / 2 matches')).toBeInTheDocument()
    await userEvent.click(down)
    expect(await screen.findByText('2 / 2 matches')).toBeInTheDocument()
    // navigation stayed in the filtered view throughout
    expect(filterInput).toHaveValue('CTX1')
  })

  it('marks exactly one active-line row in both the full and filtered views', async () => {
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
    const [fndId1] = firstSearchCall('fnd')
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({
          searchId: fndId1,
          hits: [10, 20, 30],
          scannedTo: 3_000_000,
          done: true,
          capped: false
        })
      )
    )
    expect(await screen.findByText('3 matches')).toBeInTheDocument()

    const down = screen.getByRole('button', { name: '↓' })
    await userEvent.click(down)
    await waitFor(() => expect(document.querySelectorAll('[data-active-line]')).toHaveLength(1))
    expect(document.querySelector('#line-10')).toHaveAttribute('data-active-line')

    await userEvent.click(down)
    expect(document.querySelectorAll('[data-active-line]')).toHaveLength(1)
    expect(document.querySelector('#line-20')).toHaveAttribute('data-active-line')

    // switch to the filtered view — a filter change restarts find on its own channel
    const filterInput = screen.getByPlaceholderText('filter lines')
    await userEvent.type(filterInput, 'CTX')
    await waitFor(() => expect(searchCalls('fnd').length).toBeGreaterThan(1))
    const [fltId] = lastSearchCall('flt')
    const [fndId2] = lastSearchCall('fnd')
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId: fltId, hits: [10, 20, 30], scannedTo: 3_000_000, done: true, capped: false })
      )
    )
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({
          searchId: fndId2,
          hits: [10, 20, 30],
          scannedTo: 3_000_000,
          done: true,
          capped: false
        })
      )
    )
    expect(await screen.findByText('3 filtered')).toBeInTheDocument()

    // re-seed a known position (see the sequential-navigation test above for
    // why): VirtualLines keeps its prior scroll offset across the branch switch.
    // The seed becomes the filtered view's top row (line 10) once it settles —
    // next() is exclusive, so the first press lands on the hit AFTER it (20).
    const jump = screen.getByPlaceholderText('go to line')
    await userEvent.type(jump, '1{Enter}')

    await userEvent.click(down)
    await waitFor(() => expect(document.querySelectorAll('[data-active-line]')).toHaveLength(1))
    expect(document.querySelector('#line-20')).toHaveAttribute('data-active-line')
    await userEvent.click(down)
    expect(document.querySelectorAll('[data-active-line]')).toHaveLength(1)
    expect(document.querySelector('#line-30')).toHaveAttribute('data-active-line')
  })

  it('a cut range clamps the full view and both stream starts', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    await screen.findByText('3,000,000 lines')
    const from = screen.getByPlaceholderText('from')
    const to = screen.getByPlaceholderText('to')
    await userEvent.type(from, '100')
    await userEvent.type(to, '200')
    // full view: row 0 is line 100 — rowToLine is offset by cut.from
    await waitFor(() => expect(document.querySelector('#line-100')).toBeInTheDocument())

    const filterInput = screen.getByPlaceholderText('filter lines')
    await userEvent.type(filterInput, 'CTX')
    const find = screen.getByPlaceholderText('find in file')
    await userEvent.type(find, 'ERROR')
    await waitFor(() => expect(searchCalls('fnd').length).toBeGreaterThan(0))
    const fltCall = firstSearchCall('flt')
    const fndCall = firstSearchCall('fnd')
    expect(fltCall[3]).toEqual(expect.objectContaining({ fromLine: 100, toLine: 200 }))
    expect(fndCall[3]).toEqual(expect.objectContaining({ fromLine: 100, toLine: 200 }))
  })

  it('cut from beyond EOF clamps to the last line; a reversed to still empties the view', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    await screen.findByText('3,000,000 lines')
    const from = screen.getByPlaceholderText('from')
    await userEvent.type(from, '4000000')
    // from > totalLines clamps to totalLines — the full view collapses to the
    // single last line rather than an out-of-range window
    await waitFor(() => expect(document.querySelector('#line-3000000')).toBeInTheDocument())
    expect(document.querySelectorAll('[data-vrow]')).toHaveLength(1)
    // a to below the (clamped) from is a reversed range — empty view, 0 rows
    await userEvent.type(screen.getByPlaceholderText('to'), '200')
    await waitFor(() => expect(document.querySelectorAll('[data-vrow]')).toHaveLength(0))
  })

  it('find follows the filter frontier when the filter stream is capped', async () => {
    render(
      <TextViewer
        source={{ kind: 'evidence', evidenceId: 2 }}
        focusStart={1}
        focusEnd={1}
        onClose={vi.fn()}
      />
    )
    const filterInput = await screen.findByPlaceholderText('filter lines')
    await userEvent.type(filterInput, 'CTX')
    await waitFor(() => expect(searchCalls('flt').length).toBeGreaterThan(0))
    const [fltId] = firstSearchCall('flt')
    // capped filter batch: only the first 1,000,000 lines have been validated
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({
          searchId: fltId,
          hits: [10, 500_000],
          scannedTo: 1_000_000,
          done: false,
          capped: true
        })
      )
    )
    expect(await screen.findByText('2 filtered')).toBeInTheDocument()

    const find = screen.getByPlaceholderText('find in file')
    await userEvent.type(find, 'ERROR')
    await waitFor(() => expect(searchCalls('fnd').length).toBeGreaterThan(0))
    const fndCall = firstSearchCall('fnd')
    // fnd is scoped to the filter frontier, not EOF
    expect(fndCall[3]).toEqual(expect.objectContaining({ toLine: 1_000_000 }))
    const [fndId] = fndCall

    // the engine legitimately reports done at the artificial boundary — the
    // hook must rewrite that terminal state as capped (resumable), or the tail
    // of the file becomes silently unsearchable
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId: fndId, hits: [10], scannedTo: 1_000_000, done: true, capped: false })
      )
    )
    expect(await screen.findByText(/1 matches — more on demand/)).toBeInTheDocument()

    // ↓ lands on the one collected hit; the next ↓ exhausts the hits and must
    // resume BOTH streams past the shared frontier
    const down = screen.getByRole('button', { name: '↓' })
    await userEvent.click(down)
    await userEvent.click(down)
    await waitFor(() => {
      expect(window.argus.textdoc.search).toHaveBeenCalledWith(
        fltId,
        { kind: 'evidence', evidenceId: 2 },
        'CTX',
        expect.objectContaining({ fromLine: 1_000_001 })
      )
      expect(window.argus.textdoc.search).toHaveBeenCalledWith(
        fndId,
        { kind: 'evidence', evidenceId: 2 },
        'ERROR',
        expect.objectContaining({ fromLine: 1_000_001 })
      )
    })

    // the filter's extended batch arrives and completes the filter stream
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({
          searchId: fltId,
          hits: [1_500_000],
          scannedTo: 3_000_000,
          done: true,
          capped: false
        })
      )
    )
    expect(await screen.findByText('3 filtered')).toBeInTheDocument()
    // the fnd resume was still frontier-scoped and comes back empty at the old
    // ceiling — it must STAY resumable (capped), not settle as done
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({ searchId: fndId, hits: [], scannedTo: 1_000_000, done: true, capped: false })
      )
    )
    expect(await screen.findByText(/1 matches — more on demand/)).toBeInTheDocument()

    // next ↓ resumes fnd again — the filter is no longer capped, so this
    // resume runs unbounded to EOF
    await userEvent.click(down)
    await waitFor(() =>
      expect(lastSearchCall('fnd')[3]).toEqual(
        expect.objectContaining({ fromLine: 1_000_001, toLine: undefined })
      )
    )
    act(() =>
      searchHitsCbs.forEach((cb) =>
        cb({
          searchId: fndId,
          hits: [1_500_000],
          scannedTo: 3_000_000,
          done: true,
          capped: false
        })
      )
    )
    // now genuinely done: plain count, and the new hit is navigable
    expect(await screen.findByText('2 matches')).toBeInTheDocument()
    await userEvent.click(down)
    expect(await screen.findByText('2 / 2 matches')).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector('#line-1500000')).toBeInTheDocument())
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
