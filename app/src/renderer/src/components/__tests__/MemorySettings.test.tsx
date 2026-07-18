// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemorySettings } from '../settings/MemorySettings'
import { accessStore } from '../../lib/accessStore'

const topics = {
  topics: [
    {
      name: 'tile-blocks',
      sizeBytes: 2048,
      lastWritten: '2026-07-10T10:00:00.000Z',
      enabled: true
    },
    {
      name: 'binder',
      sizeBytes: 512,
      lastWritten: '2026-07-10T11:00:00.000Z',
      enabled: false
    }
  ],
  indexLines: 2,
  capLines: 200
}
const audit = [
  {
    ts: '2026-07-10T10:00:00.000Z',
    caseSlug: 'NAV-1',
    topic: 'tile-blocks',
    indexEntry: 'tv',
    bytes: 64
  }
]

beforeEach(() => {
  accessStore.reset()
  let currentAccess: { skills: Record<string, boolean>; memory: Record<string, boolean> } = {
    skills: {},
    memory: { binder: false }
  }
  window.argus = {
    access: {
      get: vi.fn(async () => ({ access: currentAccess, loadError: null })),
      patch: vi.fn(async (p: { memory?: Record<string, boolean> }) => {
        currentAccess = {
          ...currentAccess,
          memory: { ...currentAccess.memory, ...(p.memory ?? {}) }
        }
        return { access: currentAccess, loadError: null }
      }),
      onChanged: vi.fn(() => () => {})
    },
    memory: {
      topics: vi.fn(async () => topics),
      read: vi.fn(async () => 'topic body'),
      write: vi.fn(async () => topics),
      remove: vi.fn(async () => topics),
      audit: vi.fn(async () => audit)
    }
  } as never
})

describe('MemorySettings', () => {
  it('lists topics with enablement and the audit feed', async () => {
    render(<MemorySettings />)
    expect(await screen.findByText('tile-blocks')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'enabled · binder' })).toHaveProperty(
      'ariaChecked',
      'false'
    )
    expect(screen.getByText(/2 \/ 200/)).toBeTruthy() // index line budget
    expect(await screen.findByText('NAV-1')).toBeTruthy() // audit case chip
  })

  it('toggle patches agent-access memory map', async () => {
    render(<MemorySettings />)
    const toggle = await screen.findByRole('switch', { name: 'enabled · tile-blocks' })
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(window.argus.access.patch).toHaveBeenCalledWith({ memory: { 'tile-blocks': false } })
    )
    await waitFor(() => expect(toggle).toHaveProperty('ariaChecked', 'false'))
  })

  it('delete confirms then calls remove', async () => {
    window.confirm = vi.fn(() => true)
    render(<MemorySettings />)
    fireEvent.click((await screen.findAllByRole('button', { name: /delete/i }))[0])
    await waitFor(() => expect(window.argus.memory.remove).toHaveBeenCalledWith('tile-blocks'))
  })
})

describe('MemorySettings editing', () => {
  it('the pencil becomes a save button while editing, and saving closes the editor', async () => {
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit tile-blocks' }))
    const box = await screen.findByLabelText('edit · tile-blocks')
    expect((box as HTMLTextAreaElement).value).toBe('topic body')
    // the same row affordance now offers Save, not another Edit
    expect(screen.queryByRole('button', { name: 'Edit tile-blocks' })).toBeNull()

    fireEvent.change(box, { target: { value: 'edited body' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save tile-blocks' }))
    await waitFor(() => expect(screen.queryByLabelText('edit · tile-blocks')).toBeNull())
    expect(window.argus.memory.write).toHaveBeenCalledWith('tile-blocks', 'edited body')
    expect(screen.getByRole('button', { name: 'Edit tile-blocks' })).toBeTruthy()
  })

  it('Cancel closes without writing — an editor you can only leave by saving is a trap', async () => {
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit tile-blocks' }))
    fireEvent.change(await screen.findByLabelText('edit · tile-blocks'), {
      target: { value: 'discard me' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('edit · tile-blocks')).toBeNull()
    expect(window.argus.memory.write).not.toHaveBeenCalled()
  })

  it('Escape cancels', async () => {
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit tile-blocks' }))
    fireEvent.keyDown(await screen.findByLabelText('edit · tile-blocks'), { key: 'Escape' })
    expect(screen.queryByLabelText('edit · tile-blocks')).toBeNull()
    expect(window.argus.memory.write).not.toHaveBeenCalled()
  })

  it('typing does not write — only Save does (no commit-on-blur)', async () => {
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit tile-blocks' }))
    const box = await screen.findByLabelText('edit · tile-blocks')
    fireEvent.change(box, { target: { value: 'half typed' } })
    fireEvent.blur(box)
    expect(window.argus.memory.write).not.toHaveBeenCalled()
    expect(screen.getByLabelText('edit · tile-blocks')).toBeTruthy() // still open
  })

  it('the index editor uses the same toggle', async () => {
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit _index' }))
    fireEvent.change(await screen.findByLabelText('edit · _index'), {
      target: { value: '- [a](a.md) — x' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save _index' }))
    await waitFor(() =>
      expect(window.argus.memory.write).toHaveBeenCalledWith('_index', '- [a](a.md) — x')
    )
  })
})
