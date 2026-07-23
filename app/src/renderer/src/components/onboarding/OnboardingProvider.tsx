import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useSettingsPayload } from '../../lib/settingsStore'
import { shouldOpenOnboarding, markCompleted, onboardingReplay } from '../../lib/onboardingStore'
import { SetupWizard } from './SetupWizard'
import { WelcomeStep, ProviderStep, PackStep, IntegrationsStep, SeedStep } from './steps'
import { SAMPLE_CASE_SLUG, type WizardStepId } from '../../../../shared/onboarding'
import { tourStore, useTour } from '../../lib/tourStore'
import { TourCompanion } from './TourCompanion'

export function OnboardingProvider({
  onNavigate
}: {
  /**
   * Navigate the app. `target` is the case slug when `view === 'case'`, or the
   * settings page id when `view === 'settings'` (used by wizard "configure in
   * Settings" steps and, absent, opens Settings to its default page).
   */
  onNavigate: (view: 'case' | 'settings', target?: string) => void
}): React.JSX.Element | null {
  const payload = useSettingsPayload()
  const replay = useSyncExternalStore(onboardingReplay.subscribe, onboardingReplay.get)
  const tour = useTour()
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

  // A wizard step wants to configure something in Settings. Hide the wizard for
  // this session (without marking onboarding complete) and open the page; the
  // user resumes via "Re-run onboarding" (an explicit replay) once configured.
  const openSettingsFromWizard = useCallback(
    (page?: string): void => {
      onboardingReplay.clear()
      setDismissed(true)
      onNavigate('settings', page)
    },
    [onNavigate]
  )

  const finish = useCallback((): void => {
    onboardingReplay.clear()
    const slug = seededSlug ?? SAMPLE_CASE_SLUG
    void markCompleted().then(() => {
      setDismissed(true)
      onNavigate('case', slug)
      tourStore.startTour()
    })
  }, [onNavigate, seededSlug])

  const dismiss = useCallback((): void => {
    onboardingReplay.clear()
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
        case 'provider':
          return <ProviderStep setGate={api.setGate} />
        case 'pack':
          return <PackStep onOpenSettings={() => openSettingsFromWizard('sources')} />
        case 'integrations':
          return <IntegrationsStep />
        case 'seed':
          return <SeedStep setGate={api.setGate} onSeeded={handleSeeded} />
        default:
          return null
      }
    },
    [handleSeeded, openSettingsFromWizard]
  )

  // Checked BEFORE the first-run/replay open-gate below: by the time the tour
  // starts (wizard finish), markCompleted has already run, so the wizard branch
  // would otherwise short-circuit to null. The Settings "Take the feature tour"
  // replay reaches this same branch after onboarding is long complete.
  if (payload && tour.open) {
    const slug = payload.settings.onboarding.sampleCaseSlug ?? SAMPLE_CASE_SLUG
    return (
      <TourCompanion
        sampleSlug={slug}
        settings={payload.settings}
        onNavigate={(view, page) => onNavigate(view, view === 'case' ? slug : page)}
        onExit={() => onNavigate('case', slug)}
      />
    )
  }

  if (!payload || caseCount == null) return null
  // Explicit replay (the "Re-run onboarding" button) always opens, regardless of
  // the session's dismissed flag or the auto-open heuristics. Auto-open on launch
  // stays settings-derived and is suppressed once dismissed this session.
  const open = replay || (!dismissed && shouldOpenOnboarding(payload.settings, caseCount))
  if (!open) return null

  return <SetupWizard renderStep={renderStep} onComplete={finish} onDismiss={dismiss} />
}
