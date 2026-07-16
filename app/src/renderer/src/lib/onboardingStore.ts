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

/**
 * Ephemeral, in-session "open the wizard now" signal for an explicit replay
 * (the "Re-run onboarding" button). Auto-open on launch is settings-derived
 * (see {@link shouldOpenOnboarding}); replay is a deliberate user action that
 * must open the wizard regardless of the session's dismissed state or the
 * auto-open heuristics. Mirrors the Phase-2 tour-replay pattern. Not persisted:
 * a request is a one-shot for the current app session.
 */
class OnboardingReplay {
  private requested = false
  private listeners = new Set<() => void>()

  /** Stable identity for useSyncExternalStore. */
  get = (): boolean => this.requested
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  request(): void {
    if (this.requested) return
    this.requested = true
    this.emit()
  }
  clear(): void {
    if (!this.requested) return
    this.requested = false
    this.emit()
  }
  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}

export const onboardingReplay = new OnboardingReplay()

export async function markTourDone(): Promise<void> {
  await settingsStore.patch({
    onboarding: { tourDone: true, completedAt: new Date().toISOString() }
  })
}
