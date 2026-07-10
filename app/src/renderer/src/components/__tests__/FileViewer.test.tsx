// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FileViewer } from '../FileViewer'

beforeEach(() => {
  window.argus = {
    files: {
      read: vi.fn(async () => ({ content: '# Title\n\nbody text' })),
      open: vi.fn(async () => undefined)
    }
  } as never
})

describe('FileViewer', () => {
  it('renders markdown by default and toggles to raw', async () => {
    render(<FileViewer slug="NAV-1" relPath="notes.md" onClose={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.getByText(/# Title/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Title' })).toBeNull()
  })

  it('shows plain mono text for non-markdown files (no toggle)', async () => {
    window.argus.files.read = vi.fn(async () => ({ content: 'line1\nline2' }))
    render(<FileViewer slug="NAV-1" relPath="a.log" onClose={vi.fn()} />)
    expect(await screen.findByText(/line1/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Raw' })).toBeNull()
  })

  it('tooLarge offers open-externally', async () => {
    window.argus.files.read = vi.fn(async () => ({ tooLarge: true })) as never
    render(<FileViewer slug="NAV-1" relPath="huge.log" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open externally' }))
    await waitFor(() => expect(window.argus.files.open).toHaveBeenCalledWith('NAV-1', 'huge.log'))
  })
})
