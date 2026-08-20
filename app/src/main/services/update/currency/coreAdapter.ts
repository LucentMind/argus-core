import type { ApplyOutcome, Candidate } from '../../../../shared/currency'
import type { CoreUpdatePayload } from '../../../../shared/updates'
import type { CurrencyAdapter } from './adapter'

/** Structural, not the CoreUpdaterService class — the tests need no electron-updater. */
export interface CoreUpdaterLike {
  payload(): CoreUpdatePayload
  check(opts: { manual: boolean }): Promise<CoreUpdatePayload>
  download(): Promise<CoreUpdatePayload>
}

export interface CoreAdapterDeps {
  service: CoreUpdaterLike
}

/**
 * The app itself.
 *
 * `apply` DOWNLOADS AND STOPS — it never calls `quitAndInstall`. Staging bytes is the automation;
 * the restart stays the user's click, and `autoInstallOnAppQuit` (already true) means a staged
 * update lands on the next quit either way.
 *
 * `electronUpdaterBackend`'s own `autoDownload` deliberately stays `false`: the fetch is this
 * adapter's call, which is what keeps the master switch authoritative. Flipping electron-updater's
 * flag would fetch a new version even with the switch off.
 */
export function createCoreAdapter({ service }: CoreAdapterDeps): CurrencyAdapter {
  return {
    id: 'core',

    async survey(): Promise<Candidate[]> {
      const before = service.payload()
      const phase = before.status.phase
      // `unsupported` is a structural fact about this build, not a stale answer — report it
      // without touching the network.
      if (phase === 'unsupported')
        return [
          {
            domain: 'core',
            key: 'core',
            label: 'Argus',
            from: before.currentVersion,
            to: before.currentVersion,
            verdict: 'blocked',
            reason: { kind: 'unsupported' }
          }
        ]
      // Bytes already staged, or a check/download in flight: there is nothing to discover and a
      // second check would only knock the state machine about.
      if (phase === 'ready' || phase === 'downloading' || phase === 'checking') return []

      // `manual: false` — a boot-style check whose failures are logged, not shown. A survey the
      // user did not ask for must never produce a failure banner.
      const after = await service.check({ manual: false })
      if (after.status.phase !== 'available') return []
      const { version, downgrade } = after.status
      const base = {
        domain: 'core' as const,
        key: 'core',
        label: 'Argus',
        from: after.currentVersion,
        to: version
      }
      // An offer BELOW the running version is a return to stable after leaving the beta track.
      // It is a real offer, but moving an install backwards is never something to do unattended.
      return [
        downgrade
          ? { ...base, verdict: 'blocked' as const, reason: { kind: 'downgrade' as const } }
          : { ...base, verdict: 'clean' as const }
      ]
    },

    async apply(): Promise<ApplyOutcome> {
      const after = await service.download()
      if (after.status.phase === 'error') return { ok: false, error: after.status.message }
      return { ok: true, needsRestart: true }
    }
  }
}
