// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { FileRail, BODY_PATH } from '../FileRail'
import type { ProposalFile } from '../../../../../shared/proposals'

const FILES: ProposalFile[] = [
  { path: 'scripts/collect.sh', content: '#!/bin/sh\necho hi\n', current: null, exec: true },
  { path: 'templates/report.md', content: '# Report\n', current: '# Old\n', exec: false }
]
const BODY = { current: 'old body\n', content: 'new body\n' }

function renderRail(over: Partial<Parameters<typeof FileRail>[0]> = {}): {
  onSelect: ReturnType<typeof vi.fn>
} {
  const onSelect = vi.fn()
  render(
    <FileRail
      files={FILES}
      body={BODY}
      selected={BODY_PATH}
      onSelect={onSelect}
      editedPaths={new Set()}
      {...over}
    />
  )
  return { onSelect }
}

describe('FileRail', () => {
  it('lists SKILL.md first, then every sibling', () => {
    renderRail()
    const names = screen.getAllByRole('tab').map((b) => b.textContent)
    expect(names[0]).toContain('SKILL.md')
    expect(names[1]).toContain('scripts/collect.sh')
    expect(names[2]).toContain('templates/report.md')
  })

  it('badges an executable file and only that file', () => {
    renderRail()
    const execBadges = screen.getAllByText('exec')
    expect(execBadges).toHaveLength(1)
    expect(screen.getByRole('tab', { name: /collect\.sh/ })).toHaveTextContent('exec')
  })

  it('marks the selected entry with aria-selected', () => {
    renderRail({ selected: 'scripts/collect.sh' })
    expect(screen.getByRole('tab', { name: /collect\.sh/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByRole('tab', { name: /SKILL\.md/ })).toHaveAttribute('aria-selected', 'false')
  })

  it('reports the clicked path', () => {
    const { onSelect } = renderRail()
    fireEvent.click(screen.getByRole('tab', { name: /collect\.sh/ }))
    expect(onSelect).toHaveBeenCalledWith('scripts/collect.sh')
  })

  it('shows a per-file diffstat, and none for a new file', () => {
    renderRail()
    // report.md: one line replaced → +1 −1. collect.sh is new → no stat rendered.
    expect(screen.getByRole('tab', { name: /report\.md/ })).toHaveTextContent('+1')
    expect(screen.getByRole('tab', { name: /report\.md/ })).toHaveTextContent('−1')
    expect(screen.getByRole('tab', { name: /collect\.sh/ })).toHaveTextContent('new')
  })

  it('marks an edited file as edited', () => {
    renderRail({ editedPaths: new Set(['scripts/collect.sh']) })
    expect(screen.getByRole('tab', { name: /collect\.sh/ })).toHaveTextContent('edited')
    expect(screen.getByRole('tab', { name: /SKILL\.md/ })).not.toHaveTextContent('edited')
  })

  it('marks an unreadable file so the reviewer cannot miss it', () => {
    renderRail({
      files: [{ path: 'scripts/x.sh', content: '', current: null, exec: true, unreadable: true }]
    })
    expect(screen.getByRole('tab', { name: /x\.sh/ })).toHaveTextContent('unreadable')
  })
})
