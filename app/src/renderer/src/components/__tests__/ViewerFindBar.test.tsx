// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { ViewerFindBar } from '../ViewerFindBar'

const base = {
  query: 'ERROR',
  regex: false,
  caseSensitive: false,
  filterMode: false,
  hits: [10, 20, 30],
  done: true,
  capped: false,
  scannedTo: 100,
  activeIdx: 1 as number | null
}

describe('ViewerFindBar', () => {
  it('shows the match count and active position', () => {
    render(
      <ViewerFindBar
        state={base}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
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
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    expect(screen.getByText('3 matches')).toBeInTheDocument()
  })

  it('shows a searching label while not done', () => {
    render(
      <ViewerFindBar
        state={{ ...base, done: false, activeIdx: null }}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    expect(screen.getByText('3… searching')).toBeInTheDocument()
  })

  it('flags capped searches as resumable', () => {
    render(
      <ViewerFindBar
        state={{ ...base, capped: true, done: false }}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    expect(screen.getByText(/3 matches — more on demand/)).toBeInTheDocument()
  })

  it('formats large match counts with thousands separators', () => {
    render(
      <ViewerFindBar
        state={{ ...base, hits: Array.from({ length: 12345 }, (_, i) => i), activeIdx: null }}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    expect(screen.getByText('12,345 matches')).toBeInTheDocument()
  })

  it('Enter/Shift-Enter step next/prev; toggles fire', async () => {
    const onNext = vi.fn()
    const onPrev = vi.fn()
    const onToggle = vi.fn()
    render(
      <ViewerFindBar
        state={base}
        onQueryChange={vi.fn()}
        onToggle={onToggle}
        onNext={onNext}
        onPrev={onPrev}
      />
    )
    const input = screen.getByPlaceholderText('find in file')
    await userEvent.type(input, '{Enter}')
    expect(onNext).toHaveBeenCalledOnce()
    await userEvent.type(input, '{Shift>}{Enter}{/Shift}')
    expect(onPrev).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByTitle('filter to matches'))
    expect(onToggle).toHaveBeenCalledWith('filterMode')
  })

  it('toggles regex and match-case', async () => {
    const onToggle = vi.fn()
    render(
      <ViewerFindBar
        state={base}
        onQueryChange={vi.fn()}
        onToggle={onToggle}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTitle('regex'))
    expect(onToggle).toHaveBeenCalledWith('regex')
    await userEvent.click(screen.getByTitle('match case'))
    expect(onToggle).toHaveBeenCalledWith('caseSensitive')
  })

  it('the ↑/↓ buttons call prev/next', async () => {
    const onNext = vi.fn()
    const onPrev = vi.fn()
    render(
      <ViewerFindBar
        state={base}
        onQueryChange={vi.fn()}
        onToggle={vi.fn()}
        onNext={onNext}
        onPrev={onPrev}
      />
    )
    await userEvent.click(screen.getByText('↑'))
    expect(onPrev).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByText('↓'))
    expect(onNext).toHaveBeenCalledOnce()
  })

  it('Escape clears the query without bubbling', async () => {
    const onQueryChange = vi.fn()
    const parentKeyDown = vi.fn()
    render(
      <div onKeyDown={parentKeyDown}>
        <ViewerFindBar
          state={base}
          onQueryChange={onQueryChange}
          onToggle={vi.fn()}
          onNext={vi.fn()}
          onPrev={vi.fn()}
        />
      </div>
    )
    const input = screen.getByPlaceholderText('find in file')
    await userEvent.type(input, '{Escape}')
    expect(onQueryChange).toHaveBeenCalledWith('')
    expect(parentKeyDown).not.toHaveBeenCalled()
  })

  it('types into the query input', async () => {
    const onQueryChange = vi.fn()
    render(
      <ViewerFindBar
        state={{ ...base, query: '' }}
        onQueryChange={onQueryChange}
        onToggle={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    )
    const input = screen.getByPlaceholderText('find in file')
    await userEvent.type(input, 'X')
    expect(onQueryChange).toHaveBeenCalledWith('X')
  })
})
