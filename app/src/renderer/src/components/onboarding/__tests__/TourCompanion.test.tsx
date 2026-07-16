// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TourCompanion } from '../TourCompanion'
import { tourStore } from '../../../lib/tourStore'
import { composerDraft } from '../../../lib/composerDraft'
import { defaultSettings, type AppSettings } from '../../../../../shared/settings'

function withIntegrations(mut: (s: AppSettings) => void): AppSettings {
  const s = defaultSettings()
  mut(s)
  return s
}

let emitAgentEvent: ((e: unknown) => void) | null = null

beforeEach(() => {
  emitAgentEvent = null
  window.argus = {
    sessions: { list: vi.fn(async () => [{ id: 7 }]) },
    agent: {
      onEvent: vi.fn((cb: (e: unknown) => void) => {
        emitAgentEvent = cb
        return () => {
          emitAgentEvent = null
        }
      })
    }
  } as never
  tourStore.startTour()
})

function writeMemoryDone(caseSlug: string): void {
  emitAgentEvent?.({
    type: 'tool.call.completed',
    caseSlug,
    payload: {
      toolCallId: 't1',
      name: 'mcp__argus__write_memory',
      outputPreview: 'memory/topic.md updated',
      isError: false
    }
  })
}

describe('TourCompanion', () => {
  it('memory step stages the suggested prompt into the composer', async () => {
    const setSpy = vi.spyOn(composerDraft, 'set')
    render(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={vi.fn()}
        onExit={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /stage prompt/i }))
    await waitFor(() =>
      expect(setSpy).toHaveBeenCalledWith(
        'sample-onboarding',
        7,
        expect.stringContaining('Remember')
      )
    )
  })

  it('memory step reveals the Memory settings tab after the agent writes a memory', async () => {
    const onNavigate = vi.fn()
    render(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={onNavigate}
        onExit={vi.fn()}
      />
    )
    // Phase A: staging the prompt on the case view.
    expect(screen.getByRole('button', { name: /stage prompt/i })).toBeTruthy()

    // The agent finishes writing the memory on the sample case.
    act(() => writeMemoryDone('sample-onboarding'))

    // Phase B: navigate to Settings and drop the stage-prompt affordance.
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('settings'))
    expect(screen.getByText(/just stored/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /stage prompt/i })).toBeNull()
  })

  it('ignores write_memory completions from other cases', () => {
    const onNavigate = vi.fn()
    render(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={onNavigate}
        onExit={vi.fn()}
      />
    )
    act(() => writeMemoryDone('some-other-case'))
    // Still on the case view (phase A); no settings navigation triggered.
    expect(onNavigate).not.toHaveBeenCalledWith('settings')
    expect(screen.getByRole('button', { name: /stage prompt/i })).toBeTruthy()
  })

  it('references step shows the explain card when Confluence is not configured', () => {
    render(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={vi.fn()}
        onExit={vi.fn()}
      />
    )
    // advance to references (index 2)
    act(() => tourStore.goto(2))
    expect(screen.getByText(/Connect Confluence/i)).toBeTruthy()
  })

  it('references step shows live narration when Confluence IS configured', () => {
    const s = withIntegrations((x) => {
      x.onboarding.integrations.confluence = true
    })
    render(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={s}
        onNavigate={vi.fn()}
        onExit={vi.fn()}
      />
    )
    act(() => tourStore.goto(2))
    expect(screen.getByText(/synced references/i)).toBeTruthy()
  })

  it('exit marks the tour done', async () => {
    const onExit = vi.fn()
    render(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={vi.fn()}
        onExit={onExit}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /exit tour/i }))
    await waitFor(() => expect(onExit).toHaveBeenCalled())
  })
})
