import { useSyncExternalStore } from 'react'
import { FolderGit2, X } from 'lucide-react'
import { uiStore, UI_SCALES, type Theme, type UiScale } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { confirm } from '../../lib/confirmStore'
import { onboardingReplay } from '../../lib/onboardingStore'
import { tourStore } from '../../lib/tourStore'
import { Btn, Chip, IconBtn } from '../ui'
import { RepoPickerMenu } from '../RepoPickerMenu'
import { SettingsSection, SettingRow, Switch, SelectField } from './settingsLayout'
import { UpdateSettings } from './UpdateSettings'
import type { SettingsPayload } from '../../../../shared/settings'

export function GeneralSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const g = payload.settings.general

  return (
    <>
      {/* Untitled: the page label in the header masthead already says "General", and this
          section is the whole page (user-directed, 2026-08-02). */}
      <SettingsSection>
        <SettingRow label="Theme" description="This window only (stored locally)">
          <SelectField
            aria-label="Theme"
            value={ui.theme}
            options={['dark', 'light']}
            onChange={(v) => uiStore.setTheme(v as Theme)}
          />
        </SettingRow>
        <SettingRow
          label="Dynamic theme"
          description="Ambient dashboard styling — this window only (stored locally)"
        >
          <Switch
            checked={ui.dynamicTheme}
            onChange={(v) => uiStore.setDynamicTheme(v)}
            aria-label="Dynamic theme"
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
          label="Similar past cases"
          description="Search this install's own case history for matches when a case opens"
          isDefault={!g.similarPastCasesEnabled}
          onReset={() => void settingsStore.patch({ general: { similarPastCasesEnabled: null } })}
        >
          <Switch
            checked={g.similarPastCasesEnabled}
            onChange={(v) => void settingsStore.patch({ general: { similarPastCasesEnabled: v } })}
            aria-label="Similar past cases"
          />
        </SettingRow>
        <SettingRow
          label="Default repositories"
          description="Automatically linked to new cases"
          isDefault={g.defaultRepos.length === 0}
          onReset={() => void settingsStore.patch({ general: { defaultRepos: null } })}
          stacked
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            {g.defaultRepos.length === 0 && <span className="text-xs text-dim">not set</span>}
            {g.defaultRepos.map((p) => {
              const name = p.split(/[\\/]/).pop() ?? p
              return (
                <div
                  key={p}
                  className="group/repo flex min-w-0 items-center gap-1.5 rounded-r2 border border-transparent px-1.5 py-1 transition-colors hover:border-hair hover:bg-hair/50"
                >
                  <FolderGit2 size={12} className="shrink-0 text-mute" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={p}>
                    {name}
                  </span>
                  <IconBtn
                    size="xs"
                    aria-label={`Remove ${p}`}
                    title="Remove from defaults"
                    className="shrink-0 opacity-0 transition-opacity hover:text-danger group-hover/repo:opacity-100 group-focus-within/repo:opacity-100"
                    onClick={() =>
                      void settingsStore.patch({
                        general: { defaultRepos: g.defaultRepos.filter((d) => d !== p) }
                      })
                    }
                  >
                    <X size={12} />
                  </IconBtn>
                </div>
              )
            })}
          </div>
          <RepoPickerMenu
            onPick={(p) =>
              void settingsStore.patch({ general: { defaultRepos: [...g.defaultRepos, p] } })
            }
            exclude={g.defaultRepos}
            trigger={{ text: 'Add…' }}
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
              void confirm({
                title: 'Change data folder?',
                message:
                  'Argus will relaunch and start reading/writing from the new folder. Move any existing data there yourself first if you want to keep it.',
                confirmLabel: 'Continue'
              }).then((ok) => {
                if (ok) void window.argus.settings.setDataRoot()
              })
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
      <UpdateSettings />
    </>
  )
}
