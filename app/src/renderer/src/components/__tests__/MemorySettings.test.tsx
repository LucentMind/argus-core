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
  window.argus = {
    access: {
      get: vi.fn(async () => ({
        access: { skills: {}, memory: { binder: false } },
        loadError: null
      })),
      patch: vi.fn(async () => ({
        access: { skills: {}, memory: {} },
        loadError: null
      })),
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
    fireEvent.click(await screen.findByRole('switch', { name: 'enabled · tile-blocks' }))
    await waitFor(() =>
      expect(window.argus.access.patch).toHaveBeenCalledWith({ memory: { 'tile-blocks': false } })
    )
  })

  it('delete confirms then calls remove', async () => {
    window.confirm = vi.fn(() => true)
    render(<MemorySettings />)
    fireEvent.click((await screen.findAllByRole('button', { name: /delete/i }))[0])
    await waitFor(() => expect(window.argus.memory.remove).toHaveBeenCalledWith('tile-blocks'))
  })
})
