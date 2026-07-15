import { useState } from 'react'
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
  onDismiss
}: {
  onComplete: (sampleCaseSlug: string) => void
  onDismiss: () => void
}): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const id = WIZARD_STEPS[index]
  const isLast = index === WIZARD_STEPS.length - 1
  const next = (): void => setIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1))
  const back = (): void => setIndex((i) => Math.max(i - 1, 0))

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
            <div data-testid={`wizard-step-${id}`}>{/* step body injected in later tasks */}</div>
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
                className="rounded-r2 bg-hi px-3 py-1.5 text-xs text-ink"
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
