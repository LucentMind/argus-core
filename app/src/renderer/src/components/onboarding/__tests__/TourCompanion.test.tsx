// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TourCompanion } from '../TourCompanion'
import { tourStore } from '../../../lib/tourStore'
import { composerDraft } from '../../../lib/composerDraft'
import { defaultSettings } from '../../../../../shared/settings'

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

    // Phase B: navigate to the Memory settings PAGE (not just "settings") and
    // drop the stage-prompt affordance.
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('settings', 'memory'))
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
    expect(onNavigate.mock.calls.some((c) => c[0] === 'settings')).toBe(false)
    expect(screen.getByRole('button', { name: /stage prompt/i })).toBeTruthy()
  })

  it('the Proposals step opens the Proposals settings page (not just "settings")', () => {
    const onNavigate = vi.fn()
    act(() => tourStore.goto(1)) // proposals = second step
    render(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={onNavigate}
        onExit={vi.fn()}
      />
    )
    // The bug: a settings step used to land on the default (General) page,
    // ringing the right tab but showing the wrong pane. It must open the
    // named page.
    expect(onNavigate).toHaveBeenCalledWith('settings', 'proposals')
  })

  it('re-navigates to each page when stepping between two settings steps', () => {
    const onNavigate = vi.fn()
    act(() => tourStore.goto(1)) // proposals
    const { rerender } = render(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={onNavigate}
        onExit={vi.fn()}
      />
    )
    expect(onNavigate).toHaveBeenCalledWith('settings', 'proposals')

    // Advance to the Library step — still a settings step, but a DIFFERENT page.
    // The anti-flicker guard must not swallow this: keying on view alone left
    // every later settings step stranded on the first page.
    act(() => tourStore.goto(2)) // skills -> Library page
    rerender(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={onNavigate}
        onExit={vi.fn()}
      />
    )
    expect(onNavigate).toHaveBeenCalledWith('settings', 'library')
  })

  it('HiveMind step shows the explain card when no repo is configured', () => {
    render(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={vi.fn()}
        onExit={vi.fn()}
      />
    )
    act(() => tourStore.goto(3)) // hivemind = last step
    expect(screen.getByText(/Settings > Team/i)).toBeTruthy()
  })

  it('navigates a settings step exactly once even as onNavigate identity churns (flicker regression)', () => {
    // Repro of the case<->settings flicker: OnboardingProvider passes a fresh
    // inline onNavigate every render, so the nav effect saw a new dependency on
    // each render and re-fired. The effect must navigate only when the effective
    // destination (view + page) actually CHANGES.
    const spy = vi.fn()
    act(() => tourStore.goto(1)) // proposals = a settings-view step
    const { rerender } = render(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={(v, p) => spy(v, p)}
        onExit={vi.fn()}
      />
    )
    // Simulate the parent re-rendering repeatedly with a brand-new onNavigate
    // identity each time (as the real render loop did).
    for (let i = 0; i < 5; i++) {
      rerender(
        <TourCompanion
          sampleSlug="sample-onboarding"
          settings={defaultSettings()}
          onNavigate={(v, p) => spy(v, p)}
          onExit={vi.fn()}
        />
      )
    }
    expect(spy.mock.calls.filter((c) => c[0] === 'settings')).toHaveLength(1)
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
