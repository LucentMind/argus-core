// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { PromptsDevPage } from '../PromptsDevPage'
import type { PromptCatalogPayload } from '../../../../../shared/promptsIpc'

vi.mock('../../../lib/confirmStore', async (orig) => ({
  ...(await orig<typeof import('../../../lib/confirmStore')>()),
  confirm: vi.fn(async () => true)
}))

const catalog: PromptCatalogPayload = {
  modes: ['investigation', 'review'],
  activeOverrideIds: [],
  loadError: null,
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
      preview: vi.fn(async () => preview),
      setOverride: vi.fn(async () => catalog),
      clearOverride: vi.fn(async () => catalog),
      clearAll: vi.fn(async () => catalog),
      overrides: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {})
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

const overriddenCatalog: PromptCatalogPayload = {
  ...catalog,
  activeOverrideIds: ['persona.neutral'],
  entries: catalog.entries.map((e) =>
    e.id === 'persona.neutral'
      ? { ...e, overrideText: 'MY OVERRIDE', chars: 'MY OVERRIDE'.length }
      : e
  )
}

describe('PromptsDevPage — editing', () => {
  it('saves an edited entry and shows the overridden chip', async () => {
    const api = (
      window as unknown as {
        argus: { devPrompts: { setOverride: ReturnType<typeof vi.fn> } }
      }
    ).argus.devPrompts
    api.setOverride = vi.fn(async () => overriddenCatalog)

    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Role-neutral core/ }))
    fireEvent.change(await screen.findByLabelText(/Prompt text/i), {
      target: { value: 'MY OVERRIDE' }
    })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    await waitFor(() =>
      expect(api.setOverride).toHaveBeenCalledWith('persona.neutral', 'MY OVERRIDE')
    )
    expect(await screen.findByText(/overridden/i)).toBeInTheDocument()
  })

  it('surfaces a failed save instead of silently discarding the edit', async () => {
    const api = (
      window as unknown as {
        argus: { devPrompts: { setOverride: ReturnType<typeof vi.fn> } }
      }
    ).argus.devPrompts
    api.setOverride = vi.fn(async () => {
      throw new Error('dev tools are not enabled (set ARGUS_DEV_TOOLS=1)')
    })

    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Role-neutral core/ }))
    fireEvent.change(await screen.findByLabelText(/Prompt text/i), {
      target: { value: 'MY OVERRIDE' }
    })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    expect(await screen.findByText(/dev tools are not enabled/i)).toBeInTheDocument()
    // The catalog must stay on screen — a failed save must not read as a blank page.
    expect(screen.getByText('Role-neutral core')).toBeInTheDocument()
  })

  it('Save is disabled until the text actually changes', async () => {
    // Without this, a stray click writes an override identical to the default — which then shows
    // as "overridden" forever and is indistinguishable from a real edit in the banner.
    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Role-neutral core/ }))
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Prompt text/i), { target: { value: 'CHANGED' } })
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeEnabled()
  })

  it('Revert restores the textarea without calling IPC', async () => {
    const api = (
      window as unknown as { argus: { devPrompts: { setOverride: ReturnType<typeof vi.fn> } } }
    ).argus.devPrompts
    api.setOverride = vi.fn(async () => overriddenCatalog)

    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Role-neutral core/ }))
    const box = screen.getByLabelText(/Prompt text/i)
    fireEvent.change(box, { target: { value: 'SCRATCH' } })
    fireEvent.click(screen.getByRole('button', { name: /^Revert$/ }))
    expect((box as HTMLTextAreaElement).value).toContain('Non-negotiable working rules')
    expect(api.setOverride).not.toHaveBeenCalled()
  })

  it('Reset to default clears the override after confirmation', async () => {
    const api = (
      window as unknown as {
        argus: { devPrompts: { clearOverride: ReturnType<typeof vi.fn>; catalog: unknown } }
      }
    ).argus.devPrompts
    api.clearOverride = vi.fn(async () => catalog)
    api.catalog = vi.fn(async () => overriddenCatalog)

    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Role-neutral core/ }))
    expect(await screen.findByText(/overridden/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Reset to default/i }))
    // confirmStore renders <ConfirmHost/> at the app root, which is not mounted here — the
    // dialog is stubbed in beforeEach, so this resolves immediately.
    await waitFor(() => expect(api.clearOverride).toHaveBeenCalledWith('persona.neutral'))
    // clearOverride resolves to the non-overridden catalog above — the chip must actually
    // disappear, not just have the IPC call fire.
    await waitFor(() => expect(screen.queryByText(/overridden/i)).not.toBeInTheDocument())
  })

  it("Reset to default's confirm copy warns that an unsaved draft edit is discarded too", async () => {
    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Role-neutral core/ }))
    fireEvent.click(screen.getByRole('button', { name: /Reset to default/i }))
    const confirmMock = (await import('../../../lib/confirmStore')).confirm as ReturnType<
      typeof vi.fn
    >
    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect(confirmMock.mock.calls[0][0]).toMatchObject({
      message: expect.stringMatching(/unsaved draft/i)
    })
  })

  it('does not offer editing for a read-only entry', async () => {
    render(<PromptsDevPage />)
    fireEvent.click(await screen.findByRole('button', { name: /claude_code preset/ }))
    expect(screen.queryByLabelText(/Prompt text/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Save$/ })).not.toBeInTheDocument()
  })

  it('re-reads the catalog when the change broadcast fires elsewhere (e.g. the banner)', async () => {
    // The banner and this page are siblings under Settings and share one broadcast
    // (dev-prompts:changed). A "Clear all" click in the banner must be reflected here too —
    // otherwise the page keeps showing the stale "overridden" chip and stale draft text, and
    // saving that draft would re-apply an override the developer just deleted.
    const api = (
      window as unknown as {
        argus: {
          devPrompts: {
            catalog: ReturnType<typeof vi.fn>
            onChanged: ReturnType<typeof vi.fn>
          }
        }
      }
    ).argus.devPrompts
    api.catalog = vi.fn(async () => overriddenCatalog)

    render(<PromptsDevPage />)
    expect(await screen.findByText(/overridden/i)).toBeInTheDocument()

    // Capture the callback the page subscribed with, then simulate the broadcast firing after
    // the banner cleared the override elsewhere. The next catalog() read reflects that.
    const onBroadcast = api.onChanged.mock.calls[0][0] as (ids: string[]) => void
    const rereadCatalog = vi.fn(async () => catalog)
    api.catalog = rereadCatalog
    onBroadcast([])

    await waitFor(() => expect(rereadCatalog).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText(/overridden/i)).not.toBeInTheDocument())
  })

  it('surfaces a malformed override file instead of silently showing defaults', async () => {
    const api = (window as unknown as { argus: { devPrompts: { catalog: unknown } } }).argus
      .devPrompts
    api.catalog = vi.fn(async () => ({
      ...catalog,
      loadError: 'Unexpected token n in JSON at position 2'
    }))
    render(<PromptsDevPage />)
    expect(await screen.findByText(/override file/i)).toBeInTheDocument()
    expect(screen.getByText(/Unexpected token/)).toBeInTheDocument()
  })
})
