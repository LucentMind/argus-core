// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { CaseCard } from '../CaseCard'
import type { CaseRecord } from '../../../../shared/types'
import type { ActionItem } from '../../../../shared/triage'
import { DEFAULT_MODE } from '../../../../shared/modes'

const attention: ActionItem[] = [{ kind: 'comments', severity: 'action', label: '2 new comments' }]

function rec(mut?: (c: CaseRecord) => void): CaseRecord {
  const c: CaseRecord = {
    id: 1,
    slug: 'NAV-1',
    title: 'Bearing jumps',
    jiraKey: 'NAV-1',
    jiraSyncedAt: null,
    jiraDeselected: [],
    jiraStatus: null,
    jiraPriority: 'High',
    jiraCommentCount: null,
    jiraAttachmentIds: [],
    reviewBaseline: null,
    lastSyncError: null,
    status: 'open',
    resolution: null,
    activeMode: DEFAULT_MODE,
    tags: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    actionItems: attention
  }
  mut?.(c)
  return c
}

function mount(c: CaseRecord, dynamic: boolean, index = 0): HTMLElement {
  const { container } = render(
    <CaseCard
      c={c}
      onOpen={vi.fn()}
      onExport={vi.fn()}
      onDelete={vi.fn()}
      note={null}
      dynamic={dynamic}
      index={index}
    />
  )
  return container
}

describe('CaseCard dynamic variant', () => {
  it('classic mode is untouched: no glass, no rail', () => {
    const el = mount(rec(), false)
    expect(el.querySelector('.glass-card')).toBeNull()
    expect(el.querySelector('[data-testid="priority-rail"]')).toBeNull()
  })

  it('dynamic + priority + action item → glass card with a p1 rail and stagger delay', () => {
    const el = mount(rec(), true, 3)
    const card = el.querySelector('.glass-card') as HTMLElement
    expect(card).not.toBeNull()
    expect(card.style.getPropertyValue('--d')).toBe('170ms') // 50 + 3 * 40
    const rail = el.querySelector('[data-testid="priority-rail"]') as HTMLElement
    expect(rail).not.toBeNull()
    expect(rail.getAttribute('data-tier')).toBe('p1')
  })

  it('medium priority wires through as a p2 rail', () => {
    const el = mount(
      rec((c) => (c.jiraPriority = 'Medium')),
      true
    )
    const rail = el.querySelector('[data-testid="priority-rail"]') as HTMLElement
    expect(rail).not.toBeNull()
    expect(rail.getAttribute('data-tier')).toBe('p2')
  })

  it('rail marks needs-attention, not importance: no action items → no rail', () => {
    const el = mount(
      rec((c) => (c.actionItems = [])),
      true
    )
    expect(el.querySelector('.glass-card')).not.toBeNull()
    expect(el.querySelector('[data-testid="priority-rail"]')).toBeNull()
  })

  it('no rail without a mappable priority, even with action items', () => {
    const el = mount(
      rec((c) => (c.jiraPriority = null)),
      true
    )
    expect(el.querySelector('[data-testid="priority-rail"]')).toBeNull()
  })

  it('info-severity items alone do not earn a rail', () => {
    const el = mount(
      rec((c) => (c.actionItems = [{ kind: 'idle', severity: 'info', label: 'idle 3w' }])),
      true
    )
    expect(el.querySelector('[data-testid="priority-rail"]')).toBeNull()
  })
})
