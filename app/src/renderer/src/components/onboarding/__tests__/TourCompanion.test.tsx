// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TourCompanion } from '../TourCompanion'
import { tourStore } from '../../../lib/tourStore'
import { composerDraft } from '../../../lib/composerDraft'
import { defaultSettings } from '../../../../../shared/settings'
import { TOUR_PROMPTS } from '../../../../../shared/tourPrompts'

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

  it('the Proposals step opens the top-level proposals view (not a settings page)', () => {
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
    // Proposals moved out of Settings into its own top-level view (Task 6/7/8), reached from
    // the TopBar's Inbox button — the step now navigates straight there, with no settings page.
    expect(onNavigate).toHaveBeenCalledWith('proposals', undefined)
  })

  it('the Proposals step spotlights the TopBar anchor (topbar-proposals), not the settings rail', () => {
    // A stand-in for the TopBar's Inbox button — Coachmark resolves purely by
    // `[data-onboarding-anchor]` selector, so a bare stub node is enough to prove the step points
    // at 'topbar-proposals' and not the old settings-rail id. If it targeted the wrong id this
    // stub would go unmatched and Coachmark would fall back to its centered callout (no ring).
    const stub = document.createElement('div')
    stub.setAttribute('data-onboarding-anchor', 'topbar-proposals')
    document.body.appendChild(stub)
    act(() => tourStore.goto(1)) // proposals = second step
    render(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={vi.fn()}
        onExit={vi.fn()}
      />
    )
    expect(screen.getByTestId('coachmark-ring')).toBeTruthy()
    document.body.removeChild(stub)
  })

  it('re-navigates to each page when stepping between two settings steps', () => {
    // Proposals is a top-level view now (Task 6/7/8), not a settings page, so this uses two
    // steps that both still land in Settings: Library and HiveMind.
    const onNavigate = vi.fn()
    act(() => tourStore.goto(2)) // skills -> Library page
    const { rerender } = render(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={onNavigate}
        onExit={vi.fn()}
      />
    )
    expect(onNavigate).toHaveBeenCalledWith('settings', 'library')

    // Advance to the HiveMind step — still a settings step, but a DIFFERENT page.
    // The anti-flicker guard must not swallow this: keying on view alone left
    // every later settings step stranded on the first page.
    act(() => tourStore.goto(3)) // hivemind -> Team page
    rerender(
      <TourCompanion
        sampleSlug="sample-onboarding"
        settings={defaultSettings()}
        onNavigate={onNavigate}
        onExit={vi.fn()}
      />
    )
    expect(onNavigate).toHaveBeenCalledWith('settings', 'team')
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
    act(() => tourStore.goto(2)) // skills/library = a settings-view step
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

describe('tour prompt honours a dev override', () => {
  /** The outer beforeEach builds window.argus without devPrompts (that is the gate-off shape).
   *  Augment it rather than replacing it, so sessions.list and agent.onEvent still work. */
  const withDevPrompts = (resolve: () => Promise<string>): void => {
    ;(window.argus as unknown as Record<string, unknown>).devPrompts = { resolve: vi.fn(resolve) }
  }

  it('stages the resolved text when the gate is on', async () => {
    withDevPrompts(async () => 'OVERRIDDEN PROMPT')
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
      expect(setSpy).toHaveBeenCalledWith('sample-onboarding', 7, 'OVERRIDDEN PROMPT')
    )
  })

  it('falls back to the shipped text when the gated call refuses', async () => {
    // The gate is off for every ordinary user, so a refusal is the NORMAL path, not an error.
    withDevPrompts(async () => {
      throw new Error('dev tools are not enabled (set ARGUS_DEV_TOOLS=1)')
    })
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
      expect(setSpy).toHaveBeenCalledWith('sample-onboarding', 7, TOUR_PROMPTS['tour.memory'].text)
    )
  })
})
