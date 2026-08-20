// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FilesPanel } from '../FilesPanel'
import type { SkillFileEntry } from '../../../../../shared/skillFilesIpc'

const files: SkillFileEntry[] = [
  {
    relPath: 'scripts/collect.sh',
    bytes: 18,
    executable: true,
    tier: 'user',
    editable: true
  },
  { relPath: 'templates/report.md', bytes: 9, executable: false, tier: 'user', editable: true }
]

function panel(
  over: Partial<React.ComponentProps<typeof FilesPanel>> = {}
): React.ComponentProps<typeof FilesPanel> {
  const props = {
    files,
    activeFile: null,
    editable: true,
    onOpen: vi.fn(),
    onAdd: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    ...over
  }
  render(<FilesPanel {...props} />)
  return props
}

describe('FilesPanel', () => {
  it('lists every sibling by its POSIX path', () => {
    panel()
    expect(screen.getByText('scripts/collect.sh')).toBeTruthy()
    expect(screen.getByText('templates/report.md')).toBeTruthy()
  })

  it('marks the executable ones', () => {
    panel()
    const row = screen.getByText('scripts/collect.sh').closest('li')!
    expect(row.textContent).toMatch(/exec/i)
    expect(screen.getByText('templates/report.md').closest('li')!.textContent).not.toMatch(/exec/i)
  })

  it('opens a file when its row is clicked', () => {
    // Exact match, not the substring regex the brief sketched: "Rename scripts/collect.sh" and
    // "Delete scripts/collect.sh" both contain this path too, so a regex here matches three
    // buttons and `getByRole` throws. The open button's accessible name is the bare path (no
    // `aria-label`), so an exact string singles it out.
    const p = panel()
    fireEvent.click(screen.getByRole('button', { name: 'scripts/collect.sh' }))
    expect(p.onOpen).toHaveBeenCalledWith('scripts/collect.sh')
  })

  it('says so when the skill has no siblings', () => {
    panel({ files: [] })
    expect(screen.getByText(/no files/i)).toBeTruthy()
  })

  it('offers add, rename and delete when the skill is editable', () => {
    panel()
    expect(screen.getByRole('button', { name: /add file/i })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /rename/i }).length).toBe(2)
    expect(screen.getAllByRole('button', { name: /delete/i }).length).toBe(2)
  })

  it('offers none of them when the skill is read-only', () => {
    panel({ editable: false })
    expect(screen.queryByRole('button', { name: /add file/i })).toBeNull()
    expect(screen.queryAllByRole('button', { name: /rename/i })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: /delete/i })).toHaveLength(0)
  })

  it('marks the active file', () => {
    panel({ activeFile: 'scripts/collect.sh' })
    expect(
      screen.getByRole('button', { name: 'scripts/collect.sh' }).getAttribute('aria-current')
    ).toBe('true')
  })
})
