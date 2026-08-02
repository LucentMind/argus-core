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
        {status.phase === 'available'
          ? `Argus ${status.version} is available.`
          : `Argus ${status.version} is ready to install.`}
      </span>
      {status.phase === 'available' ? (
        <Btn onClick={() => void updateStore.download()}>Download</Btn>
      ) : (
        <Btn onClick={() => void updateStore.restart()}>Restart now</Btn>
      )}
      <Btn onClick={() => updateStore.dismiss()} aria-label="Dismiss update notice">
        Dismiss
      </Btn>
    </div>
  )
}
