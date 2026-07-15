import { useCallback, useEffect, useState } from 'react'
import { useSettingsPayload } from '../../lib/settingsStore'
import { shouldOpenOnboarding, markCompleted } from '../../lib/onboardingStore'
import { SetupWizard } from './SetupWizard'
import { WelcomeStep, ClaudeStep, PackStep, IntegrationsStep, SeedStep } from './steps'
import { SAMPLE_CASE_SLUG, type WizardStepId } from '../../../../shared/onboarding'

export function OnboardingProvider({
  onOpenCase
}: {
  onOpenCase: (slug: string) => void
}): React.JSX.Element | null {
  const payload = useSettingsPayload()
  const [caseCount, setCaseCount] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState(false)
  // The slug SeedStep actually seeded — completion navigates here (falling back
  // to the well-known constant), never to a value trusted from the wizard's
  // onComplete callback, since Finish can only fire once seeding succeeded.
  const [seededSlug, setSeededSlug] = useState<string | null>(null)

  useEffect(() => {
    void window.argus.cases.list().then((c) => setCaseCount(c.length))
  }, [])

  const handleSeeded = useCallback((slug: string) => setSeededSlug(slug), [])

  const finish = useCallback((): void => {
    void markCompleted().then(() => {
      setDismissed(true)
      onOpenCase(seededSlug ?? SAMPLE_CASE_SLUG)
    })
  }, [onOpenCase, seededSlug])

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
          return <SeedStep setGate={api.setGate} onSeeded={handleSeeded} />
        default:
          return null
      }
    },
    [handleSeeded]
  )

  if (!payload || caseCount == null || dismissed) return null
  if (!shouldOpenOnboarding(payload.settings, caseCount)) return null

  return <SetupWizard renderStep={renderStep} onComplete={finish} onDismiss={dismiss} />
}
