import { useEffect, useSyncExternalStore } from 'react'
import { updateStore } from '../../lib/updateStore'
import { describeUpdate } from '../../../../shared/updates'
import { Btn } from '../ui'
import { SettingsSection, SettingRow } from './settingsLayout'

export function UpdateSettings(): React.JSX.Element {
  const { currentVersion, status } = useSyncExternalStore(
    (cb) => updateStore.subscribe(cb),
    () => updateStore.get()
  )
  useEffect(() => updateStore.start(), [])

  const busy = status.phase === 'checking' || status.phase === 'downloading'

  return (
    <SettingsSection title="Updates">
      <SettingRow label="Version" description={describeUpdate(status)}>
        <div className="flex items-center gap-2">
          <span className="text-sm text-dim">{currentVersion}</span>
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
