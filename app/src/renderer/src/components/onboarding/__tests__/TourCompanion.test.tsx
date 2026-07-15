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

beforeEach(() => {
  window.argus = { sessions: { list: vi.fn(async () => [{ id: 7 }]) } } as never
  tourStore.startTour()
})

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
