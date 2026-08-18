import { useEffect, useSyncExternalStore } from 'react'
import { updateStore } from '../lib/updateStore'
import { Btn } from './ui'

/** Thin app-wide strip for the two states worth interrupting for: available, and ready. */
export function UpdateBanner(): React.JSX.Element | null {
  const { status } = useSyncExternalStore(
    (cb) => updateStore.subscribe(cb),
    () => updateStore.get()
  )
  useEffect(() => updateStore.start(), [])

  if (status.phase !== 'available' && status.phase !== 'ready') return null
  if (updateStore.isDismissed(status.phase, status.version)) return null

  return (
    <div className="relative z-10 flex items-center gap-3 border-b border-hair bg-panel px-4 py-2 text-sm">
      <span className="flex-1">
        {status.phase === 'ready'
          ? `Argus ${status.version} is ready to install.`
          : status.downgrade
            ? // Leaving the prerelease track offers an OLDER build. "is available" would read as
              // a new release; this is the one sentence that says what it actually is.
              `Argus ${status.version} is the current stable release.`
            : `Argus ${status.version} is available.`}
      </span>
      {status.phase === 'available' ? (
        <Btn onClick={() => void updateStore.download()}>
          {status.downgrade ? 'Install' : 'Download'}
        </Btn>
      ) : (
        <Btn onClick={() => void updateStore.restart()}>Restart now</Btn>
      )}
      <Btn onClick={() => updateStore.dismiss()} aria-label="Dismiss update notice">
        Dismiss
      </Btn>
    </div>
  )
}
