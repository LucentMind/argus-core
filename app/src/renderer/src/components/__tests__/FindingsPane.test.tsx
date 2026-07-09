// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FindingsPane } from '../FindingsPane'
import { uiStore } from '../../lib/uiStore'

beforeEach(() => {
  localStorage.clear()
  uiStore.setFindingsCollapsed(false)
  window.argus = {
    cases: {
      readFindings: vi.fn(async () => '# Findings\n\n## Tile crash\nsee [evidence/log.txt:3]')
    },
    agent: { onEvent: vi.fn(() => () => undefined) }
  } as never
})

describe('FindingsPane', () => {
  it('renders findings markdown with citations', async () => {
    render(<FindingsPane slug="NAV-1" onCite={vi.fn()} />)
    expect(await screen.findByText('Tile crash')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'evidence/log.txt:3' })).toBeTruthy()
  })

  it('collapse button collapses the pane via the ui store', () => {
    render(<FindingsPane slug="NAV-1" onCite={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse findings' }))
    expect(uiStore.get().findingsCollapsed).toBe(true)
  })
})
