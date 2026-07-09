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
    render(<CaseDashboard cases={cases} onOpen={onOpen} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByText('Bearing jumps'))
    expect(onOpen).toHaveBeenCalledWith('NAV-1')
    expect(screen.getByText('analyzing')).toBeTruthy()
  })

  it('creates a case from the new-case card', () => {
    const onCreate = vi.fn()
    render(<CaseDashboard cases={[]} onOpen={vi.fn()} onCreate={onCreate} />)
    fireEvent.change(screen.getByPlaceholderText('slug (e.g. NAVAPI-123)'), {
      target: { value: 'NAV-9' }
    })
    fireEvent.change(screen.getByPlaceholderText('title'), { target: { value: 'New defect' } })
    fireEvent.click(screen.getByRole('button', { name: /create case/i }))
    expect(onCreate).toHaveBeenCalledWith({
      slug: 'NAV-9',
      title: 'New defect',
      jiraKey: undefined
    })
  })
})
