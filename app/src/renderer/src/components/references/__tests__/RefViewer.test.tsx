// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { RefViewer, MarkdownViewer } from '../RefViewer'
import { __resetEscapeLayersForTest } from '../../../lib/escapeLayer'

afterEach(() => __resetEscapeLayersForTest())

beforeEach(() => {
  window.argus = {
    refsync: {
      readRef: vi.fn(async () => ({ file: 'glossary.md', content: '# Title\n\nbody text' }))
    }
  } as never
})

describe('RefViewer', () => {
  it('renders markdown by default and toggles to raw', async () => {
    render(<RefViewer file="glossary.md" onClose={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.getByText(/# Title/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Title' })).toBeNull()
  })

  it('shows an error state when the read rejects, and Close still works', async () => {
    window.argus.refsync.readRef = vi.fn(async () => {
      throw new Error('gone')
    })
    const onClose = vi.fn()
    render(<RefViewer file="deleted.md" onClose={onClose} />)
    expect(await screen.findByText(/file could not be read/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(<RefViewer file="glossary.md" onClose={onClose} />)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('carries the reference aria-label', async () => {
    render(<RefViewer file="glossary.md" onClose={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'reference · glossary.md' })).toBeTruthy()
    )
  })
})

describe('MarkdownViewer', () => {
  it('renders loaded markdown with a Raw toggle', async () => {
    render(
      <MarkdownViewer
        title="skills / rca"
        ariaLabel="skill · rca"
        load={() => Promise.resolve('# Heading\n\nbody text')}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText('Heading')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.getByText(/# Heading/)).toBeInTheDocument()
  })

  it('shows the error state when the loader rejects', async () => {
    render(
      <MarkdownViewer
        title="skills / gone"
        ariaLabel="skill · gone"
        load={() => Promise.reject(new Error('nope'))}
        onClose={vi.fn()}
      />
    )
    expect(await screen.findByText('File could not be read.')).toBeInTheDocument()
  })
})
