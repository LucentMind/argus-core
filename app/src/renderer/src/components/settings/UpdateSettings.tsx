import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { updateStore } from '../../lib/updateStore'
import { settingsStore, useSettingsPayload } from '../../lib/settingsStore'
import { describeUpdate } from '../../../../shared/updates'
import type { CurrencyPayload } from '../../../../shared/currency'
import { Btn, Toggle } from '../ui'
import { SettingsSection, SettingRow } from './settingsLayout'

/** Consecutive clicks on the version number must land within this window to count toward the
 *  hidden dev-tools unlock below — otherwise idle clicks scattered across a session would
 *  eventually add up to an accidental unlock. */
const UNLOCK_CLICK_WINDOW_MS = 1500
const UNLOCK_CLICK_COUNT = 6
/** How long the confirmation stays up next to the version before fading back to silence. */
const UNLOCK_MESSAGE_TTL_MS = 5000

/** The one place the survey status is worded. `blocked` is per-survey truth, so an empty list a
 *  moment after launch means "not surveyed yet", not "nothing wrong" — hence the null branch. */
function currencyLine(c: CurrencyPayload | null): string {
  if (!c || c.lastSurveyAt === null) return 'Not checked yet'
  const when = new Date(c.lastSurveyAt).toLocaleString()
  if (c.blocked.length === 0) return `Checked ${when} · everything current`
  const n = c.blocked.length
  return `Checked ${when} · ${n} item${n === 1 ? '' : 's'} held back`
}

export function UpdateSettings(): React.JSX.Element {
  const { currentVersion, status, channel } = useSyncExternalStore(
    (cb) => updateStore.subscribe(cb),
    () => updateStore.get()
  )
  useEffect(() => updateStore.start(), [])

  // The master toggle governs applying and the background poll, not checking — Packs and
  // HiveMind keep their own mount-time refresh regardless of this switch (see their
  // `currency.surveyNow` calls). `auto` is read from settings, not the currency payload below:
  // it is the persisted preference, and must reflect a just-written patch immediately rather
  // than waiting on the next survey broadcast.
  const settingsPayload = useSettingsPayload()
  const auto = settingsPayload?.settings.updates.auto ?? true

  const [currency, setCurrency] = useState<CurrencyPayload | null>(null)
  useEffect(() => {
    void window.argus.currency.get().then(setCurrency)
    return window.argus.currency.onChanged(setCurrency)
  }, [])

  const busy = status.phase === 'checking' || status.phase === 'downloading'
  // A staged download installs on the next quit no matter what the channel setting says
  // afterwards (autoInstallOnAppQuit), so the switch must not pretend otherwise. Main refuses
  // the same two phases; this is the half the user can see.
  const staged = status.phase === 'downloading' || status.phase === 'ready'

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
      <SettingRow
        label="Keep everything up to date"
        description="Argus, packs, and HiveMind skills and references update themselves in the background. Anything with local edits or a change you would need to approve is held back and listed here."
        isDefault={auto}
        onReset={() => void settingsStore.patch({ updates: { auto: null } })}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-dim">{currencyLine(currency)}</span>
          <Toggle
            checked={auto}
            aria-label="Keep everything up to date"
            label=""
            onChange={(v) => void settingsStore.patch({ updates: { auto: v } })}
          />
        </div>
      </SettingRow>
      <SettingRow label="Version" description={describeUpdate(status)}>
        <div className="flex items-center gap-2">
          <span className="select-none text-sm text-dim" onClick={onVersionClick}>
            {currentVersion}
          </span>
          {unlockMessage && <span className="text-xs text-dim">{unlockMessage}</span>}
          {status.phase === 'available' && (
            <Btn onClick={() => void updateStore.download()}>
              {status.downgrade ? 'Install' : 'Download'} {status.version}
            </Btn>
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
      {status.phase !== 'unsupported' && (
        <SettingRow
          label="Prerelease builds"
          description={
            status.phase === 'ready'
              ? `Restart to finish installing ${status.version} first.`
              : status.phase === 'downloading'
                ? 'Wait for the download in progress to finish first.'
                : 'Prerelease builds ship early and are less tested. Switching back to stable offers you the current stable release, even if that means going back a version.'
          }
          isDefault={channel === 'stable'}
          onReset={() => void settingsStore.patch({ updates: { channel: null } })}
        >
          <Toggle
            checked={channel === 'beta'}
            disabled={staged}
            aria-label="Prerelease builds"
            label=""
            onChange={(v) =>
              void settingsStore.patch({ updates: { channel: v ? 'beta' : 'stable' } })
            }
          />
        </SettingRow>
      )}
    </SettingsSection>
  )
}
