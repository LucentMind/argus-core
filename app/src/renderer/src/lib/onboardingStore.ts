import type { AppSettings } from '../../../shared/settings'
import { settingsStore, useSettingsPayload } from './settingsStore'

/** True first run: never finished onboarding AND the user has no cases yet. */
export function isFirstRun(settings: AppSettings, caseCount: number): boolean {
  return settings.onboarding.completedAt == null && caseCount === 0
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

export function useOnboarding(): { settings: AppSettings | null } {
  const payload = useSettingsPayload()
  return { settings: payload?.settings ?? null }
}
