// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ImportSkillsDialog } from '../ImportSkillsDialog'
import type { SkillImportCandidate, SkillImportApplyResult } from '../../../../../shared/memoryIpc'

function mockArgus(): {
  skills: { scanImport: ReturnType<typeof vi.fn>; applyImport: ReturnType<typeof vi.fn> }
  workspaces: { pick: ReturnType<typeof vi.fn> }
} {
  return {
    skills: { scanImport: vi.fn(), applyImport: vi.fn() },
    workspaces: { pick: vi.fn() }
  }
}

let argus: ReturnType<typeof mockArgus>

beforeEach(() => {
  argus = mockArgus()
  ;(window as unknown as { argus: unknown }).argus = argus
})

const globalScan: SkillImportCandidate[] = [
  {
    name: 'my-notes',
    sourceDir: '/home/me/.claude/skills/my-notes',
    description: 'Personal notes',
    status: 'importable'
  },
  {
    name: 'rca',
    sourceDir: '/home/me/.claude/skills/rca',
    description: 'already have it',
    status: 'conflict',
    reason: 'Already in your Library.'
  },
  {
    name: 'broken',
    sourceDir: '/home/me/.claude/skills/broken',
    description: '',
    status: 'invalid',
    reason: 'Missing frontmatter — the file must start with a --- fenced block.'
  }
]

describe('ImportSkillsDialog', () => {
  it('scans the global directory on mount and disables conflict/invalid rows', async () => {
    argus.skills.scanImport.mockResolvedValue(globalScan)
    render(<ImportSkillsDialog onClose={vi.fn()} />)
    expect(await screen.findByText('my-notes')).toBeInTheDocument()
    expect(argus.skills.scanImport).toHaveBeenCalledWith({ kind: 'global' })
    expect(screen.getByLabelText('Import · my-notes')).toBeInTheDocument()
    expect(screen.queryByLabelText('Import · rca')).not.toBeInTheDocument()
    expect(screen.getByText(/Already in your Library/)).toBeInTheDocument()
    expect(screen.getByText(/Missing frontmatter/)).toBeInTheDocument()
  })

  it('browsing a project folder merges its results into the list', async () => {
    argus.skills.scanImport.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        name: 'proj-skill',
        sourceDir: '/repo/.claude/skills/proj-skill',
        description: 'from the project',
        status: 'importable'
      }
    ])
    argus.workspaces.pick.mockResolvedValue('/repo')
    render(<ImportSkillsDialog onClose={vi.fn()} />)
    await waitFor(() => expect(argus.skills.scanImport).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Browse project folder…' }))
    expect(await screen.findByText('proj-skill')).toBeInTheDocument()
    expect(argus.skills.scanImport).toHaveBeenCalledWith({ kind: 'project', dir: '/repo' })
  })

  it('select all importable checks every importable row', async () => {
    argus.skills.scanImport.mockResolvedValue(globalScan)
    render(<ImportSkillsDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByLabelText('Select all importable'))
    expect(screen.getByLabelText('Import · my-notes')).toBeChecked()
    expect(screen.getByRole('button', { name: /Import \(1\)/ })).toBeInTheDocument()
  })

  it('imports the selected items and closes on full success', async () => {
    argus.skills.scanImport.mockResolvedValue(globalScan)
    argus.skills.applyImport.mockResolvedValue({
      results: [{ name: 'my-notes', ok: true }],
      payload: { skills: [] }
    } satisfies SkillImportApplyResult)
    const onClose = vi.fn()
    render(<ImportSkillsDialog onClose={onClose} />)
    fireEvent.click(await screen.findByLabelText('Import · my-notes'))
    fireEvent.click(screen.getByRole('button', { name: /Import \(1\)/ }))
    await waitFor(() =>
      expect(argus.skills.applyImport).toHaveBeenCalledWith([
        { name: 'my-notes', sourceDir: '/home/me/.claude/skills/my-notes' }
      ])
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('a partial failure keeps the dialog open and shows the error inline', async () => {
    argus.skills.scanImport.mockResolvedValue(globalScan)
    argus.skills.applyImport.mockResolvedValue({
      results: [
        { name: 'my-notes', ok: false, error: '"my-notes" already exists in your Library.' }
      ],
      payload: { skills: [] }
    } satisfies SkillImportApplyResult)
    const onClose = vi.fn()
    render(<ImportSkillsDialog onClose={onClose} />)
    fireEvent.click(await screen.findByLabelText('Import · my-notes'))
    fireEvent.click(screen.getByRole('button', { name: /Import \(1\)/ }))
    expect(await screen.findByText(/already exists in your Library/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('attributes a partial failure by position when two selected items share a name from different sources', async () => {
    const projectDup: SkillImportCandidate = {
      name: 'my-notes',
      sourceDir: '/repo/.claude/skills/my-notes',
      description: 'from the project',
      status: 'importable'
    }
    argus.skills.scanImport.mockResolvedValueOnce(globalScan).mockResolvedValueOnce([projectDup])
    argus.workspaces.pick.mockResolvedValue('/repo')
    argus.skills.applyImport.mockResolvedValue({
      results: [
        { name: 'my-notes', ok: false, error: '"my-notes" already exists in your Library.' },
        { name: 'my-notes', ok: true }
      ],
      payload: { skills: [] }
    } satisfies SkillImportApplyResult)
    const onClose = vi.fn()
    render(<ImportSkillsDialog onClose={onClose} />)

    await waitFor(() => expect(argus.skills.scanImport).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Browse project folder…' }))
    await screen.findByLabelText('Import · my-notes')

    const checkboxes = screen.getAllByLabelText('Import · my-notes')
    expect(checkboxes).toHaveLength(2)
    fireEvent.click(checkboxes[0])
    fireEvent.click(checkboxes[1])
    fireEvent.click(screen.getByRole('button', { name: /Import \(2\)/ }))

    await waitFor(() =>
      expect(argus.skills.applyImport).toHaveBeenCalledWith([
        { name: 'my-notes', sourceDir: '/home/me/.claude/skills/my-notes' },
        { name: 'my-notes', sourceDir: '/repo/.claude/skills/my-notes' }
      ])
    )
    await waitFor(() => expect(checkboxes[0]).toBeChecked())
    expect(checkboxes[1]).not.toBeChecked()
    expect(screen.getByText(/already exists in your Library/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
