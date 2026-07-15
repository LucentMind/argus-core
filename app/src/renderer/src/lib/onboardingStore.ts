import type { AppSettings } from '../../../shared/settings'
import { settingsStore } from './settingsStore'

/**
 * Open the wizard on true first run (never completed AND no cases yet) OR on an
 * explicit replay (completedAt cleared but the user already did phase 1 before).
 * The `phase1Done` term is what makes "Re-run onboarding" work after the sample
 * case exists, while still NOT auto-onboarding existing users who upgrade with
 * cases but no onboarding record.
 */
export function shouldOpenOnboarding(settings: AppSettings, caseCount: number): boolean {
  const ob = settings.onboarding
  return ob.completedAt == null && (caseCount === 0 || ob.phase1Done)
}

export async function markPhase1Done(sampleCaseSlug: string): Promise<void> {
  await settingsStore.patch({ onboarding: { phase1Done: true, sampleCaseSlug } })
}

export async function markIntegration(
  key: 'jira' | 'confluence' | 'hive',
  value: boolean
): Promise<void> {
  await settingsStore.patch({ onboarding: { integrations: { [key]: value } } })
}

export async function markCompleted(): Promise<void> {
  await settingsStore.patch({ onboarding: { completedAt: new Date().toISOString() } })
}

export async function markTourDone(): Promise<void> {
  await settingsStore.patch({
    onboarding: { tourDone: true, completedAt: new Date().toISOString() }
  })
}
