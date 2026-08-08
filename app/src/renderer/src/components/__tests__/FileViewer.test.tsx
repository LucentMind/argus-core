// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import userEvent from '@testing-library/user-event'
import { FileViewer } from '../FileViewer'
import { __resetEscapeLayersForTest } from '../../lib/escapeLayer'

afterEach(() => __resetEscapeLayersForTest())

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

  it('shows an error state when the read rejects, and Close still works', async () => {
    window.argus.files.read = vi.fn(async () => {
      throw new Error('gone')
    })
    const onClose = vi.fn()
    render(<FileViewer slug="NAV-1" relPath="deleted.log" onClose={onClose} />)
    expect(await screen.findByText(/file could not be read/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows a loading placeholder in the markdown pane before the read resolves', async () => {
    let resolveRead: (v: { content: string }) => void = () => {}
    window.argus.files.read = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        })
    ) as never
    render(<FileViewer slug="NAV-1" relPath="notes.md" onClose={vi.fn()} />)
    // The placeholder is a skeleton now, not the word "Loading…" — it is named through the
    // live region rather than through visible text.
    expect(await screen.findByRole('status', { name: 'Loading' })).toBeTruthy()
    resolveRead({ content: '# Title\n\nbody text' })
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeTruthy()
  })

  // Evidence markdown is third-party bytes, not app-authored prose: Jira ticket
  // and comment dumps, and (increment 3) defect-corpus snapshots whose
  // `description` is written verbatim. An ungated anchor here is a same-window
  // top-level navigation of the real BrowserWindow, which no main-process
  // handler intercepts — the same hazard `HitDetail` was hardened against, on
  // the same bytes by a different route.
  it('gates markdown links: a dangerous scheme is inert text, an https link opens externally', async () => {
    window.argus.files.read = vi.fn(async () => ({
      content: '[go](javascript:alert(1)) and [ext](https://corpus.example/x) and plain text'
    })) as never
    render(<FileViewer slug="NAV-1" relPath="evidence/KAN-5.md" onClose={vi.fn()} />)
    expect(await screen.findByText(/and plain text/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'go' })).toBeNull()
    const ext = screen.getByRole('link', { name: 'ext' })
    expect(ext).toHaveAttribute('href', 'https://corpus.example/x')
    expect(ext).toHaveAttribute('target', '_blank')
    expect(ext).toHaveAttribute('rel', 'noreferrer')
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(<FileViewer slug="C-1" relPath="a.txt" onClose={onClose} />)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
