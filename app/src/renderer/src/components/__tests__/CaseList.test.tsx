// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CaseList } from '../CaseList'
import type { CaseRecord } from '../../../../shared/types'

const cases: CaseRecord[] = [
  {
    id: 1, slug: 'NAVAPI-1', title: 'Tile 403s', jiraKey: 'NAVAPI-1',
    status: 'open', tags: [], createdAt: '2026-07-09T00:00:00Z', updatedAt: '2026-07-09T00:00:00Z'
  }
]

describe('CaseList', () => {
  it('renders cases and selects on click', () => {
    const onSelect = vi.fn()
    render(<CaseList cases={cases} selectedSlug={null} onSelect={onSelect} onCreate={vi.fn()} />)
    fireEvent.click(screen.getByText('NAVAPI-1'))
    expect(onSelect).toHaveBeenCalledWith('NAVAPI-1')
  })

  it('submits the new-case form', () => {
    const onCreate = vi.fn()
    render(<CaseList cases={[]} selectedSlug={null} onSelect={vi.fn()} onCreate={onCreate} />)
    fireEvent.click(screen.getByText('New Case'))
    fireEvent.change(screen.getByPlaceholderText('slug (e.g. NAVAPI-12345)'), { target: { value: 'NAVAPI-9' } })
    fireEvent.change(screen.getByPlaceholderText('title'), { target: { value: 'Crash on reroute' } })
    fireEvent.click(screen.getByText('Create'))
    // slug matches the Jira-key pattern, so it doubles as jiraKey
    expect(onCreate).toHaveBeenCalledWith({ slug: 'NAVAPI-9', title: 'Crash on reroute', jiraKey: 'NAVAPI-9' })
  })
})
