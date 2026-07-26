// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { PromptsDevPage } from '../PromptsDevPage'
import type { PromptCatalogPayload } from '../../../../../shared/promptsIpc'

const catalog: PromptCatalogPayload = {
  modes: ['investigation', 'review'],
  entries: [
    {
      id: 'persona.neutral',
      category: 'persona',
      title: 'Role-neutral core',
      source: 'app/src/main/services/agent/persona.ts:12',
      reaches: 'all',
      editable: true,
      defaultText: 'Non-negotiable working rules:\n1. CITATIONS — cite every claim.',
      overrideText: null,
      chars: 62
    },
    {
      id: 'tool.grep_lines.description',
      category: 'tools',
      title: 'grep_lines — tool description',
      source: 'app/src/main/services/agent/nativeTools.ts:323',
      reaches: ['claude-agent-sdk', 'github-copilot'],
      editable: true,
      defaultText: 'Exhaustive line-number search inside ONE evidence file.',
      overrideText: null,
      chars: 54
    },
    {
      id: 'external.claude.preset',
      category: 'external',
      title: 'Anthropic claude_code preset',
      source: 'app/src/main/services/agent/drivers/claude/index.ts:141',
      reaches: ['claude-agent-sdk'],
      editable: false,
      defaultText: '',
      overrideText: null,
      chars: 0,
      note: 'Ships inside the Claude Code CLI.'
    }
  ]
}

const preview = {
  mode: 'investigation',
  text: 'IDENTITY\n\nNEUTRAL\n\nDIAGRAM',
  fragments: [
    { id: 'persona.mode.investigation', label: 'persona.mode.investigation', start: 0, end: 8 },
    { id: 'persona.neutral', label: 'persona.neutral', start: 10, end: 17 },
    { id: null, label: 'Pack persona fragment', start: 19, end: 26 }
  ],
  omits: ['Agent memory index — filtered per case', 'Skill index — depends on resolved skills']
}

beforeEach(() => {
  ;(window as unknown as { argus: unknown }).argus = {
    devPrompts: {
      catalog: vi.fn(async () => catalog),
      preview: vi.fn(async () => preview)
    }
  }
})

describe('PromptsDevPage — catalog', () => {
  it('groups entries under human-readable category headings', async () => {
    render(<PromptsDevPage />)
    expect(await screen.findByText('Persona & mode identity')).toBeInTheDocument()
    expect(screen.getByText('Tool descriptions')).toBeInTheDocument()
    expect(screen.getByText('External (not in this repo)')).toBeInTheDocument()
  })

  it('does not render headings for categories with no entries', async () => {
    render(<PromptsDevPage />)
    await screen.findByText('Persona & mode identity')
    // tool-feedback and synthesized are empty until Plan 3 — showing them would imply
    // the catalog is complete when it is not.
    expect(screen.queryByText('Tool result steering')).not.toBeInTheDocument()
    expect(screen.queryByText('Synthesized user messages')).not.toBeInTheDocument()
  })

  it('shows each entry title, source ref and size', async () => {
    render(<PromptsDevPage />)
    expect(await screen.findByText('Role-neutral core')).toBeInTheDocument()
    expect(screen.getByText('app/src/main/services/agent/persona.ts:12')).toBeInTheDocument()
    expect(screen.getByText(/62 chars/)).toBeInTheDocument()
  })

  it('expands an entry to show its text', async () => {
    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Role-neutral core/ }))
    expect(await screen.findByText(/Non-negotiable working rules/)).toBeInTheDocument()
  })

  it('renders reach as driver chips, and "all drivers" when unrestricted', async () => {
    render(<PromptsDevPage />)
    await screen.findByText('Role-neutral core')
    expect(screen.getByText(/all drivers/i)).toBeInTheDocument()
    // getAllBy, not getBy: two entries in the fixture reach claude-agent-sdk, so each renders
    // its own chip. Asserting a single match would fail on correct output.
    expect(screen.getAllByText('claude-agent-sdk').length).toBeGreaterThan(0)
    expect(screen.getByText('github-copilot')).toBeInTheDocument()
  })

  it('shows the note instead of a body for an external entry, and marks it read-only', async () => {
    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /claude_code preset/ }))
    expect(await screen.findByText(/Ships inside the Claude Code CLI/)).toBeInTheDocument()
    expect(screen.getByText(/read-only/i)).toBeInTheDocument()
  })

  it('surfaces a catalog failure instead of rendering an empty page', async () => {
    ;(
      window as unknown as { argus: { devPrompts: { catalog: unknown } } }
    ).argus.devPrompts.catalog = vi.fn(async () => {
      throw new Error('dev tools are not enabled (set ARGUS_DEV_TOOLS=1)')
    })
    render(<PromptsDevPage />)
    await waitFor(() => expect(screen.getByText(/dev tools are not enabled/i)).toBeInTheDocument())
  })
})

describe('PromptsDevPage — composed preview', () => {
  it('renders the composed text for the selected mode', async () => {
    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Composed preview/i }))
    expect(await screen.findByText(/IDENTITY/)).toBeInTheDocument()
  })

  it('lists fragment boundaries in order with their ids', async () => {
    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Composed preview/i }))
    const labels = (await screen.findAllByTestId('fragment-label')).map((n) => n.textContent)
    expect(labels).toEqual([
      'persona.mode.investigation',
      'persona.neutral',
      'Pack persona fragment'
    ])
  })

  it('states what the preview omits — it must not look like the whole prompt', async () => {
    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Composed preview/i }))
    expect(await screen.findByText(/Agent memory index/)).toBeInTheDocument()
    expect(screen.getByText(/Skill index/)).toBeInTheDocument()
  })

  it('refetches when the mode changes', async () => {
    const api = (
      window as unknown as { argus: { devPrompts: { preview: ReturnType<typeof vi.fn> } } }
    ).argus.devPrompts
    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Composed preview/i }))
    await waitFor(() => expect(api.preview).toHaveBeenCalledWith('investigation'))
    fireEvent.change(screen.getByLabelText(/mode/i), { target: { value: 'review' } })
    await waitFor(() => expect(api.preview).toHaveBeenCalledWith('review'))
  })

  it('shows the total size so persona growth is visible', async () => {
    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Composed preview/i }))
    expect(await screen.findByText(/26 chars/)).toBeInTheDocument()
  })
})
