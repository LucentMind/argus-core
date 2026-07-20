import type { AppSettings } from '../../../shared/settings'

/** Stamp the usage-tracking epoch exactly once; before it elapses staleDays no topic can be
 *  flagged stale (recall tracking hasn't had a fair observation window). */
export function ensureTrackingStarted(
  settings: { get(): AppSettings; patch(p: unknown): AppSettings },
  now: () => Date = () => new Date()
): string {
  const cur = settings.get().memoryHygiene.trackingStartedAt
  if (cur) return cur
  return settings.patch({ memoryHygiene: { trackingStartedAt: now().toISOString() } })
    .memoryHygiene.trackingStartedAt
}
