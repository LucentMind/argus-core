import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { updateStore } from '../../lib/updateStore'
import { describeUpdate } from '../../../../shared/updates'
import { Btn } from '../ui'
import { SettingsSection, SettingRow } from './settingsLayout'

/** Consecutive clicks on the version number must land within this window to count toward the
 *  hidden dev-tools unlock below — otherwise idle clicks scattered across a session would
 *  eventually add up to an accidental unlock. */
const UNLOCK_CLICK_WINDOW_MS = 1500
const UNLOCK_CLICK_COUNT = 6
/** How long the confirmation stays up next to the version before fading back to silence. */
const UNLOCK_MESSAGE_TTL_MS = 5000

export function UpdateSettings(): React.JSX.Element {
  const { currentVersion, status } = useSyncExternalStore(
    (cb) => updateStore.subscribe(cb),
    () => updateStore.get()
  )
  useEffect(() => updateStore.start(), [])

  const busy = status.phase === 'checking' || status.phase === 'downloading'

  // Refs, not state: a click counter re-rendering the page on every tap is both pointless and a
  // tell that something is listening — the whole point is that this looks like inert text.
  const clickCount = useRef(0)
  const lastClickAt = useRef(0)
  const messageTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Confirmation renders inline here rather than through `noticeStore`: that store's only
  // consumer, `HeaderNotice`, mounts exclusively inside the case header row, so a notice queued
  // while Settings is opened from the case-less landing screen — exactly the moment this
  // gesture is most likely to happen — would be pushed and silently never shown.
  const [unlockMessage, setUnlockMessage] = useState<string | null>(null)
  useEffect(() => () => clearTimeout(messageTimer.current), [])

  /** Click-6-times-on-the-version unlock for the prompt-override dev surface, which is
   *  otherwise hidden in a packaged build (spec §6 follow-up). Mirrors Android's "tap the
   *  build number" gesture — no visible affordance, just a counter reset by a pause. */
  function onVersionClick(): void {
    const now = Date.now()
    clickCount.current =
      now - lastClickAt.current > UNLOCK_CLICK_WINDOW_MS ? 1 : clickCount.current + 1
    lastClickAt.current = now
    if (clickCount.current < UNLOCK_CLICK_COUNT) return
    clickCount.current = 0
    void window.argus.devTools.unlock().then(({ devTools }) => {
      clearTimeout(messageTimer.current)
      setUnlockMessage(
        devTools
          ? 'Developer settings are already enabled.'
          : 'Developer settings unlocked — restart Argus to use them.'
      )
      messageTimer.current = setTimeout(() => setUnlockMessage(null), UNLOCK_MESSAGE_TTL_MS)
    })
  }

  return (
    <SettingsSection title="Updates">
      <SettingRow label="Version" description={describeUpdate(status)}>
        <div className="flex items-center gap-2">
          <span className="select-none text-sm text-dim" onClick={onVersionClick}>
            {currentVersion}
          </span>
          {unlockMessage && <span className="text-xs text-dim">{unlockMessage}</span>}
          {status.phase === 'available' && (
            <Btn onClick={() => void updateStore.download()}>Download {status.version}</Btn>
          )}
          {status.phase === 'ready' && (
            <Btn onClick={() => void updateStore.restart()}>Restart</Btn>
          )}
          {status.phase !== 'unsupported' && status.phase !== 'ready' && (
            <Btn disabled={busy} onClick={() => void updateStore.check()}>
              {status.phase === 'checking' ? 'Checking…' : 'Check for updates'}
            </Btn>
          )}
        </div>
      </SettingRow>
    </SettingsSection>
  )
}
