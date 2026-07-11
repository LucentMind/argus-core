import { useSyncExternalStore } from 'react'
import { uiStore, type Theme } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { Btn, Chip } from '../ui'
import {
  SettingsSection,
  SettingRow,
  Switch,
  SelectField,
  DraftInput,
  FIELD
} from './settingsLayout'
import {
  TIMESTAMP_FORMATS,
  type SettingsPayload,
  type TimestampFormat
} from '../../../../shared/settings'

export function GeneralSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const g = payload.settings.general

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="General">
        <SettingRow label="Theme" description="This window only (stored locally)">
          <SelectField
            aria-label="Theme"
            value={ui.theme}
            options={['dark', 'light']}
            onChange={(v) => uiStore.setTheme(v as Theme)}
          />
        </SettingRow>
        <SettingRow
          label="Timestamp format"
          isDefault={g.timestampFormat === 'locale'}
          onReset={() => void settingsStore.patch({ general: { timestampFormat: null } })}
        >
          <SelectField
            aria-label="Timestamp format"
            value={g.timestampFormat}
            options={TIMESTAMP_FORMATS}
            onChange={(v) =>
              void settingsStore.patch({ general: { timestampFormat: v as TimestampFormat } })
            }
          />
        </SettingRow>
        <SettingRow
          label="Confirm case delete"
          description="Ask before deleting a case (applies when case delete ships)"
          isDefault={g.confirmCaseDelete}
          onReset={() => void settingsStore.patch({ general: { confirmCaseDelete: null } })}
        >
          <Switch
            checked={g.confirmCaseDelete}
            onChange={(v) => void settingsStore.patch({ general: { confirmCaseDelete: v } })}
            aria-label="Confirm case delete"
          />
        </SettingRow>
        <SettingRow
          label="Default repository"
          description="Automatically linked to new cases"
          isDefault={g.defaultRepo === null}
          onReset={() => void settingsStore.patch({ general: { defaultRepo: null } })}
        >
          <span
            className="max-w-64 truncate font-mono text-xs text-dim"
            title={g.defaultRepo ?? undefined}
          >
            {g.defaultRepo ?? 'not set'}
          </span>
          <Btn
            onClick={() =>
              void window.argus.workspaces.pick().then((p) => {
                if (p) void settingsStore.patch({ general: { defaultRepo: p } })
              })
            }
          >
            Browse
          </Btn>
        </SettingRow>
        <SettingRow
          label="Show tool calls"
          description="Default visibility of tool-call cards (stored locally)"
        >
          <Switch
            checked={ui.showToolCalls}
            onChange={(v) => uiStore.setShowToolCalls(v)}
            aria-label="Show tool calls"
          />
        </SettingRow>
        <SettingRow
          label="Data root"
          description="Set via an environment variable"
          badge={payload.dataRoot.fromEnv ? <Chip tone="neutral">env: ARGUS_HOME</Chip> : undefined}
        >
          <span
            className="max-w-64 truncate font-mono text-xs text-dim"
            title={payload.dataRoot.path}
          >
            {payload.dataRoot.path}
          </span>
          <Btn onClick={() => void window.argus.settings.reveal('dataRoot')}>Open folder</Btn>
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="HiveMind">
        <SettingRow
          label="HiveMind repo"
          description="GitHub org/name of the shared skills & references repo. Blank keeps HiveMind features off."
          isDefault={payload.settings.hivemind.repo === ''}
          onReset={() => void settingsStore.patch({ hivemind: { repo: null } })}
        >
          <DraftInput
            aria-label="HiveMind repo"
            className={`${FIELD} w-56 font-mono`}
            placeholder="org/name"
            value={payload.settings.hivemind.repo}
            onCommit={(v) => void settingsStore.patch({ hivemind: { repo: v.trim() } })}
          />
        </SettingRow>
      </SettingsSection>
    </div>
  )
}
