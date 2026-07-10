// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { CaseDashboard } from '../CaseDashboard'
import type { CaseRecord } from '../../../../shared/types'

const cases: CaseRecord[] = [
  {
    id: 1,
    slug: 'NAV-1',
    title: 'Bearing jumps',
    jiraKey: 'NAV-1',
    status: 'analyzing',
    tags: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z'
  }
]

describe('CaseDashboard', () => {
  it('renders case cards with status chip and opens on click', () => {
    const onOpen = vi.fn()
    render(<CaseDashboard cases={cases} onOpen={onOpen} onNew={vi.fn()} />)
    fireEvent.click(screen.getByText('Bearing jumps'))
    expect(onOpen).toHaveBeenCalledWith('NAV-1')
    expect(screen.getByText('analyzing')).toBeTruthy()
  })

  it('New case card opens the dialog via onNew', () => {
    const onNew = vi.fn()
    render(<CaseDashboard cases={[]} onOpen={vi.fn()} onNew={onNew} />)
    fireEvent.click(screen.getByRole('button', { name: /new case/i }))
    expect(onNew).toHaveBeenCalled()
  })
})
