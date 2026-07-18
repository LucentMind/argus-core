// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { ViewerFindBar } from '../ViewerFindBar'
import type { FindBarState, StreamState } from '../ViewerFindBar'

const stream = (over: Partial<StreamState> = {}): StreamState => ({
  query: '',
  regex: false,
  caseSensitive: false,
  hits: [],
  done: true,
  capped: false,
  scannedTo: 0,
  ...over
})

const base: FindBarState = {
  filter: stream(),
  find: stream({ query: 'ERROR', hits: [10, 20, 30] }),
  activeIdx: 1,
  cutFrom: '',
  cutTo: ''
}

describe('ViewerFindBar', () => {
  it('shows the match count and active position', () => {
    render(
      <ViewerFindBar
        state={base}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onCutChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    expect(screen.getByText('2 / 3 matches')).toBeInTheDocument()
  })

  it('shows a plain count with no active position', () => {
    render(
      <ViewerFindBar
        state={{ ...base, activeIdx: null }}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onCutChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    expect(screen.getByText('3 matches')).toBeInTheDocument()
  })

  it('shows a searching label while not done', () => {
    render(
      <ViewerFindBar
        state={{
          ...base,
          find: stream({ query: 'ERROR', hits: [10, 20, 30], done: false }),
          activeIdx: null
        }}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onCutChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    expect(screen.getByText('3… searching')).toBeInTheDocument()
  })

  it('flags capped searches as resumable', () => {
    render(
      <ViewerFindBar
        state={{
          ...base,
          find: stream({ query: 'ERROR', hits: [10, 20, 30], capped: true, done: false })
        }}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onCutChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    expect(screen.getByText(/3 matches — more on demand/)).toBeInTheDocument()
  })

  it('formats large match counts with thousands separators', () => {
    render(
      <ViewerFindBar
        state={{
          ...base,
          find: stream({ query: 'ERROR', hits: Array.from({ length: 12345 }, (_, i) => i) }),
          activeIdx: null
        }}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onCutChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    expect(screen.getByText('12,345 matches')).toBeInTheDocument()
  })

  it('renders separate filter and find inputs with their own toggles', async () => {
    const onToggle = vi.fn()
    render(
      <ViewerFindBar
        state={base}
        onQueryChange={vi.fn()}
        onToggle={onToggle}
        onCutChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    expect(screen.getByPlaceholderText('filter lines')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('find in file')).toBeInTheDocument()
    await userEvent.click(screen.getByTitle('filter regex'))
    expect(onToggle).toHaveBeenCalledWith('filter', 'regex')
    await userEvent.click(screen.getByTitle('match case'))
    expect(onToggle).toHaveBeenCalledWith('find', 'caseSensitive')
    expect(screen.queryByTitle('filter to matches')).toBeNull() // ☰ removed
  })

  it('shows the filtered-line count when a filter is active', () => {
    render(
      <ViewerFindBar
        state={{
          ...base,
          filter: stream({ query: 'CTX1', hits: Array.from({ length: 1234 }, (_, i) => i + 1) })
        }}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onCutChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    expect(screen.getByText('1,234 filtered')).toBeInTheDocument()
  })

  it('cut inputs report raw values', async () => {
    const onCutChange = vi.fn()
    render(
      <ViewerFindBar
        state={base}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onCutChange={onCutChange}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    await userEvent.type(screen.getByPlaceholderText('from'), '5')
    expect(onCutChange).toHaveBeenCalledWith('from', '5')
  })

  it('toggle buttons are square', () => {
    render(
      <ViewerFindBar
        state={base}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onCutChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    for (const t of ['filter regex', 'filter match case', 'regex', 'match case']) {
      expect(screen.getByTitle(t).className).toContain('h-6 w-6')
    }
  })

  it('Enter/Shift-Enter on the find input step next/prev', async () => {
    const onNext = vi.fn()
    const onPrev = vi.fn()
    render(
      <ViewerFindBar
        state={base}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onCutChange={vi.fn()}
        onNext={onNext}
        onPrev={onPrev}
      />
    )
    const input = screen.getByPlaceholderText('find in file')
    await userEvent.type(input, '{Enter}')
    expect(onNext).toHaveBeenCalledOnce()
    await userEvent.type(input, '{Shift>}{Enter}{/Shift}')
    expect(onPrev).toHaveBeenCalledOnce()
  })

  it('the ↑/↓ buttons call prev/next', async () => {
    const onNext = vi.fn()
    const onPrev = vi.fn()
    render(
      <ViewerFindBar
        state={base}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onCutChange={vi.fn()}
        onNext={onNext}
        onPrev={onPrev}
      />
    )
    await userEvent.click(screen.getByText('↑'))
    expect(onPrev).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByText('↓'))
    expect(onNext).toHaveBeenCalledOnce()
  })

  it('types into the filter and find query inputs', async () => {
    const onQueryChange = vi.fn()
    render(
      <ViewerFindBar
        state={base}
        onQueryChange={onQueryChange}
        onToggle={vi.fn()}
        onCutChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    await userEvent.type(screen.getByPlaceholderText('filter lines'), 'X')
    expect(onQueryChange).toHaveBeenCalledWith('filter', 'X')
    await userEvent.type(screen.getByPlaceholderText('find in file'), 'Y')
    expect(onQueryChange).toHaveBeenCalledWith('find', 'ERRORY')
  })
})
