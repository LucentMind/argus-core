// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ExplorerFilters } from '../ExplorerFilters'
import { EXPLORER_PAGE, type ExplorerRequest } from '../RelatedHistoryExplorer'
import type { RelatedSourceInfo } from '../../../../../shared/relatedHistory'

const REQ: ExplorerRequest = {
  text: 'ecu',
  edited: true,
  mode: 'hybrid',
  filters: {},
  includeOpen: false,
  excluded: [],
  limit: EXPLORER_PAGE
}

const LOCAL: RelatedSourceInfo = {
  id: 'local',
  name: 'Your cases',
  kind: 'local',
  ok: true,
  semantic: false,
  projects: []
}
const CORPUS: RelatedSourceInfo = {
  id: 'corpus:src1',
  name: 'Hindsight',
  kind: 'corpus',
  ok: true,
  semantic: true,
  projects: ['KAN', 'NAV']
}

function setup(over: Partial<Parameters<typeof ExplorerFilters>[0]> = {}): {
  onChange: ReturnType<typeof vi.fn>
  onRetry: ReturnType<typeof vi.fn>
} {
  const onChange = vi.fn()
  const onRetry = vi.fn()
  render(
    <ExplorerFilters
      req={REQ}
      sources={[LOCAL, CORPUS]}
      health={[]}
      onChange={onChange}
      onRetry={onRetry}
      {...over}
    />
  )
  return { onChange, onRetry }
}

describe('ExplorerFilters', () => {
  it('offers the mode toggle only when a source reports semantic', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Lexical' })).toBeInTheDocument()
    screen.getByText(/corpus sources only/i)
  })

  it('hides the mode toggle when no source is semantic', () => {
    setup({ sources: [LOCAL, { ...CORPUS, semantic: false }] })
    expect(screen.queryByRole('button', { name: 'Lexical' })).not.toBeInTheDocument()
  })

  it('lists project facets from the probe, not from the results', () => {
    const { onChange } = setup()
    fireEvent.click(screen.getByLabelText('Project KAN'))
    expect(onChange).toHaveBeenCalledWith({ filters: { projects: ['KAN'] } })
  })

  it('parses a comma-separated token filter into an array', () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByLabelText('Components'), { target: { value: 'routing, hmi' } })
    expect(onChange).toHaveBeenLastCalledWith({ filters: { components: ['routing', 'hmi'] } })
  })

  it('drops a token filter entirely when its box is cleared', () => {
    const { onChange } = setup({ req: { ...REQ, filters: { components: ['routing'] } } })
    fireEvent.change(screen.getByLabelText('Components'), { target: { value: '  ' } })
    expect(onChange).toHaveBeenLastCalledWith({ filters: {} })
  })

  it('toggles include-open-cases, marked local-only', () => {
    const { onChange } = setup()
    fireEvent.click(screen.getByLabelText('Include open cases'))
    expect(onChange).toHaveBeenCalledWith({ includeOpen: true })
  })

  it('unchecking a source excludes that provider id', () => {
    const { onChange } = setup()
    fireEvent.click(screen.getByLabelText('Search Hindsight'))
    expect(onChange).toHaveBeenCalledWith({ excluded: ['corpus:src1'] })
  })

  it('shows a failed search source with its message and a retry', () => {
    const { onRetry } = setup({
      health: [
        { id: 'local', name: 'Your cases', kind: 'local', ok: true },
        { id: 'corpus:src1', name: 'Hindsight', kind: 'corpus', ok: false, error: 'fetch failed' }
      ]
    })
    expect(screen.getByText('fetch failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('shows an unreachable source from the probe even before a search runs', () => {
    setup({ sources: [LOCAL, { ...CORPUS, ok: false, error: 'no token configured' }], health: [] })
    expect(screen.getByText('no token configured')).toBeInTheDocument()
  })
})
