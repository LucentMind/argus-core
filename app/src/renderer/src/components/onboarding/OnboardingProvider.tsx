import { useCallback, useEffect, useState } from 'react'
import { useSettingsPayload } from '../../lib/settingsStore'
import { isFirstRun, markCompleted } from '../../lib/onboardingStore'
import { SetupWizard } from './SetupWizard'
import { WelcomeStep, ClaudeStep, PackStep, IntegrationsStep, SeedStep } from './steps'
import type { WizardStepId } from '../../../../shared/onboarding'

export function OnboardingProvider({
  onOpenCase
}: {
  onOpenCase: (slug: string) => void
}): React.JSX.Element | null {
  const payload = useSettingsPayload()
  const [caseCount, setCaseCount] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    void window.argus.cases.list().then((c) => setCaseCount(c.length))
  }, [])

  // Stable no-op: SeedStep's effect deps on `onSeeded`, so a fresh function each
  // render would re-run seedSample() on every provider re-render.
  const handleSeeded = useCallback(() => {}, [])

  const finish = useCallback(
    (slug: string): void => {
      void markCompleted().then(() => {
        setDismissed(true)
        onOpenCase(slug)
      })
    },
    [onOpenCase]
  )

  const dismiss = useCallback((): void => {
    void markCompleted().then(() => setDismissed(true))
  }, [])

  const renderStep = useCallback(
    (
      id: WizardStepId,
      api: { next: () => void; setGate: (ok: boolean) => void }
    ): React.ReactNode => {
      switch (id) {
        case 'welcome':
          return <WelcomeStep />
        case 'claude':
          return <ClaudeStep setGate={api.setGate} />
        case 'pack':
          return <PackStep setGate={api.setGate} />
        case 'integrations':
          return <IntegrationsStep />
        case 'seed':
          return <SeedStep onSeeded={handleSeeded} />
        default:
          return null
      }
    },
    [handleSeeded]
  )

  if (!payload || caseCount == null || dismissed) return null
  if (!isFirstRun(payload.settings, caseCount)) return null

  return <SetupWizard renderStep={renderStep} onComplete={finish} onDismiss={dismiss} />
}
