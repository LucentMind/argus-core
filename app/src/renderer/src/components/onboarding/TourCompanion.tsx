import { useEffect, useRef, useState } from 'react'
import { useTour, tourStore, buildTourSteps } from '../../lib/tourStore'
import { markTourDone } from '../../lib/onboardingStore'
import { composerDraft } from '../../lib/composerDraft'
import { Coachmark } from './Coachmark'
import type { AppSettings } from '../../../../shared/settings'
import type { TourStep } from './tourSteps'

export function TourCompanion({
  sampleSlug,
  settings,
  onNavigate,
  onExit
}: {
  sampleSlug: string
  settings: AppSettings
  onNavigate: (view: 'case' | 'settings') => void
  onExit: () => void
}): React.JSX.Element | null {
  const { open, index } = useTour()
  const steps = buildTourSteps(settings)
  const step: TourStep | undefined = steps[index]

  // Reveal phase: a step carrying `reveal` flips to a second target once the
  // watched tool completes on the sample case (e.g. Memory: stage the prompt,
  // then spotlight Settings > Memory after the agent stores it). We track the
  // step index the reveal fired for (rather than a boolean we'd have to reset),
  // so navigating away and back naturally re-derives the right phase.
  const [revealedIndex, setRevealedIndex] = useState<number | null>(null)
  const reveal = step?.reveal
  const showReveal = !!reveal && revealedIndex === index

  useEffect(() => {
    if (!open || !reveal || showReveal) return
    return window.argus.agent?.onEvent?.((e) => {
      if (
        e.type === 'tool.call.completed' &&
        e.caseSlug === sampleSlug &&
        e.payload.name === reveal.watchTool &&
        !e.payload.isError
      ) {
        setRevealedIndex(index)
      }
    })
  }, [open, reveal, showReveal, sampleSlug, index])
  const effView = showReveal && reveal ? reveal.view : step?.view
  const effTarget = showReveal && reveal ? reveal.target : step?.target
  const effNarration = showReveal && reveal ? reveal.narration : step?.narration

  // Navigate to the effective view whenever it CHANGES — keyed on the view we
  // last drove to, not on render/dependency churn. onNavigate identity is
  // unstable (the provider passes a fresh inline arrow each render), so firing
  // on every render would loop: navigate -> parent setView -> re-render -> new
  // onNavigate -> fire again. On a settings step that loop crossed the
  // openSettings toggle and oscillated case<->settings (the tour flicker).
  const lastNavView = useRef<'case' | 'settings' | null>(null)
  useEffect(() => {
    if (!open || !step || !effView) return
    if (lastNavView.current === effView) return
    lastNavView.current = effView
    onNavigate(effView)
  }, [open, step, effView, onNavigate])

  if (!open || !step) return null

  const unmet =
    step.requiresIntegration && !settings.onboarding.integrations[step.requiresIntegration]
  const isLast = index === steps.length - 1

  const finish = async (): Promise<void> => {
    await markTourDone()
    tourStore.exitTour()
    onExit()
  }

  const stagePrompt = async (): Promise<void> => {
    if (!step.suggestedPrompt) return
    const sessions = await window.argus.sessions.list(sampleSlug)
    const sid = sessions[0]?.id
    if (sid != null) composerDraft.set(sampleSlug, sid, step.suggestedPrompt)
  }

  const panel = (
    <div className="pointer-events-auto w-80 rounded-r3 border border-hair bg-deep p-4 shadow-lg">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-faint">
        Feature tour · {index + 1}/{steps.length}
      </div>
      <h3 className="text-sm text-ink">{step.title}</h3>
      {unmet ? (
        <p className="mt-2 text-xs text-dim">{step.explain}</p>
      ) : (
        <p className="mt-2 text-xs text-dim">{effNarration}</p>
      )}
      {!unmet && effView === 'case' && step.suggestedPrompt && (
        <button
          className="mt-3 rounded-r2 bg-hi px-3 py-1.5 text-xs text-ink"
          onClick={() => void stagePrompt()}
        >
          Stage prompt
        </button>
      )}
      <div className="mt-4 flex items-center justify-between">
        <button className="text-xs text-dim hover:text-ink" onClick={() => void finish()}>
          Exit tour
        </button>
        <div className="flex gap-2">
          {index > 0 && (
            <button
              className="rounded-r2 border border-hair px-3 py-1.5 text-xs"
              onClick={() => tourStore.back()}
            >
              Back
            </button>
          )}
          <button
            className="rounded-r2 bg-hi px-3 py-1.5 text-xs text-ink"
            onClick={() => (isLast ? void finish() : tourStore.next())}
          >
            {isLast ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )

  // Live steps spotlight the real control; explain/unmet steps dock bottom-right without a ring.
  if (unmet) {
    return <div className="pointer-events-none fixed bottom-6 right-6 z-[60]">{panel}</div>
  }
  return <Coachmark anchor={effTarget ?? step.target}>{panel}</Coachmark>
}
