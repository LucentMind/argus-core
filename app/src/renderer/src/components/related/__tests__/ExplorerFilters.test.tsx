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
      probed
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

  it('parses a comma-separated token filter into an array on blur', () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByLabelText('Components'), { target: { value: 'routing, hmi' } })
    fireEvent.blur(screen.getByLabelText('Components'))
    expect(onChange).toHaveBeenLastCalledWith({ filters: { components: ['routing', 'hmi'] } })
  })

  it('commits a token filter on Enter without needing a separate blur', () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByLabelText('Components'), { target: { value: 'routing' } })
    fireEvent.keyDown(screen.getByLabelText('Components'), { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith({ filters: { components: ['routing'] } })
  })

  it('drops a token filter entirely when its box is cleared', () => {
    const { onChange } = setup({ req: { ...REQ, filters: { components: ['routing'] } } })
    fireEvent.change(screen.getByLabelText('Components'), { target: { value: '  ' } })
    fireEvent.blur(screen.getByLabelText('Components'))
    expect(onChange).toHaveBeenLastCalledWith({ filters: {} })
  })

  // Important 3: every keystroke used to fire a fresh `req` (and so a fresh
  // network fan-out); typing "routing" was 7 requests against a shared,
  // bearer-token-guarded corpus with no debounce and no abort.
  it('does not call onChange while typing — only on blur or Enter', () => {
    const { onChange } = setup()
    for (const ch of 'routing') {
      fireEvent.change(screen.getByLabelText('Components'), {
        target: { value: (screen.getByLabelText('Components') as HTMLInputElement).value + ch }
      })
    }
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(screen.getByLabelText('Components'))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  // Important 2: `commitToken` had no "did anything actually change?" guard,
  // so a bare focus+blur — no keystroke at all — still re-sent `filters` as a
  // fresh object: a fresh `req` identity, and so a full IPC fan-out to every
  // configured corpus plus a paging reset, from nothing more than a user
  // tabbing through the rail.
  it('issues no onChange on a bare focus and blur, with no typing at all', () => {
    const { onChange } = setup()
    const input = screen.getByLabelText('Components')
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(onChange).not.toHaveBeenCalled()
  })

  // Pressing Enter already committed, and blur (which always follows, once
  // the user moves on) committed again — two identical fan-outs from one
  // edit. `toHaveBeenLastCalledWith` can't see a duplicate call, only the
  // call count can.
  it('commits exactly once when Enter is followed by a blur', () => {
    const { onChange } = setup()
    const input = screen.getByLabelText('Components')
    fireEvent.change(input, { target: { value: 'routing' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  // The house convention (`blurOnEscape`, used everywhere else) is that a
  // field-level Escape discards the edit. This box commits on blur, and
  // `blurOnEscape` just calls `.blur()` — so without a specific guard,
  // Escape applied the abandoned draft instead of discarding it.
  it('discards the draft on Escape, reverting the text and issuing no onChange', () => {
    const { onChange } = setup({ req: { ...REQ, filters: { components: ['original'] } } })
    const input = screen.getByLabelText('Components')
    fireEvent.change(input, { target: { value: 'typed junk' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('original')
    expect(onChange).not.toHaveBeenCalled()
  })

  // The four token inputs used `defaultValue` (uncontrolled) while the date
  // filter beside them is controlled. `defaultValue` only seeds the DOM node
  // once — after the user has ever touched the field, it stays whatever was
  // last typed no matter what `req.filters` says. Controlled means the box
  // reflects `req.filters[key]` again once there is no active draft, even
  // after the user has interacted with it.
  it('reverts to the prop value once committed, rather than sticking on stale typed text', () => {
    const onChange = vi.fn() // a stub, deliberately: does not feed back into `req`
    render(
      <ExplorerFilters
        req={{ ...REQ, filters: { components: ['original'] } }}
        sources={[LOCAL, CORPUS]}
        health={[]}
        probed
        onChange={onChange}
        onRetry={vi.fn()}
      />
    )
    const input = screen.getByLabelText('Components')
    expect(input).toHaveValue('original')
    fireEvent.change(input, { target: { value: 'typed junk' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith({ filters: { components: ['typed junk'] } })
    // The parent (a bare stub here) never actually updated `req`, so the box
    // must fall back to `req.filters` again — not stay stuck on whatever was
    // last typed, the way an uncontrolled `defaultValue` input would.
    expect(input).toHaveValue('original')
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

  it('does not show a stale probe error once the last search succeeded', () => {
    setup({
      sources: [LOCAL, { ...CORPUS, ok: false, error: 'no token configured' }],
      health: [
        { id: 'local', name: 'Your cases', kind: 'local', ok: true },
        { id: 'corpus:src1', name: 'Hindsight', kind: 'corpus', ok: true }
      ]
    })
    expect(screen.queryByText('no token configured')).not.toBeInTheDocument()
  })

  // Important 2: the rail's row set is the union of the probe (`sources`) and
  // the last search's per-provider health, keyed by id — not `sources` alone.
  // A provider that is actively part of the fan-out (e.g. local, once
  // `includeOpenCases` makes it searchable) must have a row even when the
  // probe itself never lists it, because the probe has no per-call options.
  it('shows a row for a provider that only appears in search health, not in the probe', () => {
    setup({
      sources: [CORPUS],
      health: [
        { id: 'local', name: 'Your cases', kind: 'local', ok: true },
        { id: 'corpus:src1', name: 'Hindsight', kind: 'corpus', ok: true }
      ]
    })
    expect(screen.getByLabelText('Search Your cases')).toBeInTheDocument()
  })

  it('lets a health-only row be unchecked like any other source', () => {
    const { onChange } = setup({
      sources: [CORPUS],
      health: [{ id: 'local', name: 'Your cases', kind: 'local', ok: true }]
    })
    fireEvent.click(screen.getByLabelText('Search Your cases'))
    expect(onChange).toHaveBeenCalledWith({ excluded: ['local'] })
  })

  it('shows "no searchable sources" only once a probe has actually completed', () => {
    const { rerender } = render(
      <ExplorerFilters
        req={REQ}
        sources={[]}
        health={[]}
        probed={false}
        onChange={vi.fn()}
        onRetry={vi.fn()}
      />
    )
    expect(screen.queryByText(/No searchable sources/i)).not.toBeInTheDocument()
    rerender(
      <ExplorerFilters
        req={REQ}
        sources={[]}
        health={[]}
        probed
        onChange={vi.fn()}
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByText(/No searchable sources/i)).toBeInTheDocument()
  })
})
