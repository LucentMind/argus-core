import { useSyncExternalStore } from 'react'
import { uiStore, UI_SCALES, type Theme, type UiScale } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { onboardingReplay } from '../../lib/onboardingStore'
import { tourStore } from '../../lib/tourStore'
import { Btn, Chip } from '../ui'
import { SettingsSection, SettingRow, Switch, SelectField } from './settingsLayout'
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
    <SettingsSection title="General">
      <SettingRow label="Theme" description="This window only (stored locally)">
        <SelectField
          aria-label="Theme"
          value={ui.theme}
          options={['dark', 'light']}
          onChange={(v) => uiStore.setTheme(v as Theme)}
        />
      </SettingRow>
      <SettingRow label="UI scale" description="Zoom the whole interface (this window only)">
        <SelectField
          aria-label="UI scale"
          value={`${Math.round(ui.uiScale * 100)}%`}
          options={UI_SCALES.map((s) => `${Math.round(s * 100)}%`)}
          onChange={(v) => uiStore.setUiScale((parseInt(v, 10) / 100) as UiScale)}
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
        description="Require typing the case slug before a case is deleted"
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
        <Btn
          disabled={payload.dataRoot.fromEnv}
          title={
            payload.dataRoot.fromEnv
              ? 'Controlled by the ARGUS_HOME environment variable'
              : 'Pick a new folder and relaunch — existing data stays where it is'
          }
          onClick={() => {
            if (
              window.confirm(
                'Argus will relaunch and start reading/writing from the new folder. Move any existing data there yourself first if you want to keep it. Continue?'
              )
            ) {
              void window.argus.settings.setDataRoot()
            }
          }}
        >
          Change…
        </Btn>
      </SettingRow>
      <SettingRow label="Onboarding" description="Re-open the first-run setup wizard.">
        <Btn onClick={() => onboardingReplay.request()}>Re-run onboarding</Btn>
        <Btn onClick={() => tourStore.startTour()}>Take the feature tour</Btn>
      </SettingRow>
    </SettingsSection>
  )
}
