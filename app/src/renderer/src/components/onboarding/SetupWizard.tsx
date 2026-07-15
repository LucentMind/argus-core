import { useState, useRef } from 'react'
import { WIZARD_STEPS, type WizardStepId } from '../../../../shared/onboarding'

const LABELS: Record<WizardStepId, string> = {
  welcome: 'Welcome',
  claude: 'Connect Claude',
  pack: 'Install a pack',
  integrations: 'Integrations',
  seed: 'Sample case'
}

export function SetupWizard({
  onComplete,
  onDismiss,
  renderStep
}: {
  onComplete: (sampleCaseSlug: string) => void
  onDismiss: () => void
  renderStep?: (id: WizardStepId, api: { next: () => void; setGate: (ok: boolean) => void }) => React.ReactNode
}): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [gate, setGateState] = useState(true)
  const [prevIndex, setPrevIndex] = useState(0)
  const gateRef = useRef(true)
  const id = WIZARD_STEPS[index]
  const isLast = index === WIZARD_STEPS.length - 1
  const next = (): void => setIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1))
  const back = (): void => setIndex((i) => Math.max(i - 1, 0))

  // Reset the gate synchronously when the step changes, BEFORE children mount
  // (React "adjust state during render" pattern — runs before child effects, so
  // a step that gates itself on mount is not overwritten by a later parent reset).
  if (prevIndex !== index) {
    setPrevIndex(index)
    gateRef.current = true
    setGateState(true)
  }

  // gateRef is a stable object, so the guard always reads the latest requested
  // value regardless of which render's setGate closure is calling — a step that
  // captures setGate once and later calls setGate(false) then setGate(true)
  // asynchronously re-enables Continue instead of being blocked by a stale gate.
  const setGate = (ok: boolean): void => {
    if (ok === gateRef.current) return // ref reads fresh from ANY closure — no staleness
    gateRef.current = ok
    setGateState(ok) // state → re-renders, so async setGate re-enables Continue
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 p-6">
      <div className="flex h-[560px] w-[840px] overflow-hidden rounded-r3 border border-hair bg-deep">
        <nav aria-label="Setup steps" className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-hair p-3">
          {WIZARD_STEPS.map((s, i) => (
            <div
              key={s}
              className={`rounded-r2 px-2.5 py-1.5 text-xs ${
                i === index ? 'bg-hi text-ink' : i < index ? 'text-dim' : 'text-faint'
              }`}
            >
              {LABELS[s]}
            </div>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div data-testid={`wizard-step-${id}`}>{renderStep ? renderStep(id, { next, setGate }) : null}</div>
          </div>
          <div className="flex items-center justify-between border-t border-hair p-4">
            <button className="text-xs text-dim hover:text-ink" onClick={onDismiss}>
              Skip setup
            </button>
            <div className="flex gap-2">
              {index > 0 && (
                <button className="rounded-r2 border border-hair px-3 py-1.5 text-xs" onClick={back}>
                  Back
                </button>
              )}
              <button
                disabled={!gate}
                className="rounded-r2 bg-hi px-3 py-1.5 text-xs text-ink disabled:opacity-40"
                onClick={() => (isLast ? onComplete('sample-onboarding') : next())}
              >
                {isLast ? 'Finish' : 'Continue'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
