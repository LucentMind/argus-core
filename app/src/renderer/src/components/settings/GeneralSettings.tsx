import { useState, useSyncExternalStore } from 'react'
import { FolderGit2, X } from 'lucide-react'
import { uiStore, UI_SCALES, type ThemePreference, type UiScale } from '../../lib/uiStore'
import { settingsStore } from '../../lib/settingsStore'
import { confirm } from '../../lib/confirmStore'
import { onboardingReplay } from '../../lib/onboardingStore'
import { tourStore } from '../../lib/tourStore'
import { Btn, Chip, IconBtn } from '../ui'
import { RepoPickerMenu } from '../RepoPickerMenu'
import {
  SettingsSection,
  SettingRow,
  Switch,
  SelectField,
  DisclosureOverlay,
  DisclosureChevron
} from './settingsLayout'
import { UpdateSettings } from './UpdateSettings'
import type { SettingsPayload } from '../../../../shared/settings'

/**
 * Default repositories, as a disclosure rather than an always-open list (user-directed,
 * 2026-08-08).
 *
 * The list used to sit open in the row, so a user with several defaults got a column of paths
 * wedged between two one-line switch rows, with the `Add…` button floating beside it at whatever
 * height the list happened to end. Collapsed, the row is one line like its neighbours; expanded,
 * the list gets the full row width, each entry showing its folder name over its path, with `Add…`
 * anchored under it.
 *
 * Built as a bare row rather than through `SettingRow`, and shaped after `ProviderRow`
 * (user-directed, 2026-08-08): label column, a disclosure chevron alone in the trailing slot, and the
 * disclosed content BELOW the row rather than inside its control column. `SettingRow` has no slot
 * for content under the row — a stacked one would leave the chevron's own `pt-2` control strip
 * behind while collapsed — and the trailing chevron is what makes this read as the same kind of
 * expandable thing as a provider.
 *
 * No reset button. The eraser (`Reset to default`) that every other configured row carries is
 * gone from this one: the list's own per-entry Remove is the way it empties, and a second
 * clear-everything control sitting where the chevron belongs was both redundant and the reason
 * the row had two competing affordances in its top-right corner.
 *
 * Auto-opens when there is nothing configured: an empty collapsed row is a summary of nothing,
 * and the point of opening it would only ever be to reach `Add…`.
 */
function DefaultReposRow({ repos }: { repos: readonly string[] }): React.JSX.Element {
  const [open, setOpen] = useState(repos.length === 0)

  return (
    <div className="flex flex-col px-4 py-3">
      <div className="group/disc relative flex items-center gap-4">
        <DisclosureOverlay
          expanded={open}
          onToggle={() => setOpen((o) => !o)}
          label="default repositories"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
            Default repositories
            {repos.length > 0 && <Chip tone="neutral">{repos.length}</Chip>}
          </span>
          {/* The count lives in the badge, so this line carries the other half of the collapsed
              summary — what the setting DOES — and states the empty case outright rather than
              describing a behaviour that is not happening. */}
          <span className="text-xs text-mute">
            {repos.length === 0
              ? 'None — new cases start unlinked'
              : 'Automatically linked to new cases'}
          </span>
        </div>
        <DisclosureChevron expanded={open} />
      </div>
      {open && (
        // No box of its own (user-directed, 2026-08-08): the disclosed list already sits inside
        // the settings section's card, so a second hairline rectangle around it was a border
        // drawn 4px inside another border.
        <div className="mt-2 flex flex-col gap-1">
          {repos.length === 0 && (
            <span className="px-1.5 py-1 text-xs text-mute">
              No default repositories yet — add one and every new case links it on creation.
            </span>
          )}
          {repos.map((p) => {
            const name = p.split(/[\\/]/).pop() ?? p
            return (
              <div
                key={p}
                className="group/repo flex min-w-0 items-center gap-2 rounded-r2 border border-transparent px-1.5 py-1 transition-colors hover:border-hair hover:bg-hair/50"
              >
                <FolderGit2 size={13} className="shrink-0 text-mute" aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-xs text-ink">{name}</span>
                  {/* The full path, which the old row only offered as a `title` tooltip — the
                      one thing that tells two same-named checkouts apart. */}
                  <span className="truncate text-[11px] text-mute" title={p}>
                    {p}
                  </span>
                </span>
                <IconBtn
                  size="xs"
                  aria-label={`Remove ${p}`}
                  title="Remove from defaults"
                  className="shrink-0 opacity-0 transition-opacity hover:text-danger group-hover/repo:opacity-100 group-focus-within/repo:opacity-100"
                  onClick={() =>
                    void settingsStore.patch({
                      general: { defaultRepos: repos.filter((d) => d !== p) }
                    })
                  }
                >
                  <X size={12} />
                </IconBtn>
              </div>
            )
          })}
          {/* `Add…` right-aligned (user-directed, 2026-08-08), under the chevron that opened the
              list rather than off at the far left. It is also what makes the picker's
              `align="right"` panel land beside the button instead of across the row. */}
          <div className="flex justify-end pt-1">
            <RepoPickerMenu
              onPick={(p) => void settingsStore.patch({ general: { defaultRepos: [...repos, p] } })}
              exclude={repos}
              trigger={{ text: 'Add…' }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Theme, dynamic theme and UI scale as ONE collapsed row (user-directed, 2026-08-21).
 *
 * Three window-local look-and-feel switches opened the General page and pushed everything that
 * actually configures Argus — repos, data root, updates — below the fold. They are also the
 * rows a user touches once and never again, so they earn the least permanent space.
 *
 * Shaped exactly like {@link DefaultReposRow}: bare row, a disclosure chevron alone in the trailing
 * slot, disclosed content BELOW the row. The chip is the collapsed summary — the current theme
 * and scale are what a user opening this row wants to know, so the row keeps saying them while
 * shut. Never auto-opens: unlike the repos list, an empty state is impossible here.
 */
function AppearanceRow(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const scale = `${Math.round(ui.uiScale * 100)}%`

  return (
    <div className="flex flex-col px-4 py-3">
      <div className="group/disc relative flex items-center gap-4">
        <DisclosureOverlay expanded={open} onToggle={() => setOpen((o) => !o)} label="appearance" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
            Appearance
            <Chip tone="neutral">
              {ui.themePreference} · {scale}
              {ui.dynamicTheme ? ' · dynamic' : ''}
            </Chip>
          </span>
          <span className="text-xs text-mute">
            Theme, ambient styling, and zoom — this window only (stored locally)
          </span>
        </div>
        <DisclosureChevron expanded={open} />
      </div>
      {open && (
        // Sub-rows, not `SettingRow`s: a SettingRow's `px-4` would indent them past the row they
        // belong to, and none of the three has a reset (they are local UI state, not settings
        // with a stored default to erase).
        <div className="mt-1 flex flex-col">
          <div className="flex items-center gap-4 rounded-r2 px-1.5 py-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm text-ink">Theme</span>
              <span className="text-xs text-mute">System follows your OS setting</span>
            </div>
            <SelectField
              aria-label="Theme"
              value={ui.themePreference}
              options={['system', 'dark', 'light']}
              onChange={(v) => uiStore.setThemePreference(v as ThemePreference)}
            />
          </div>
          <div className="flex items-center gap-4 rounded-r2 px-1.5 py-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm text-ink">Dynamic theme</span>
              <span className="text-xs text-mute">Ambient dashboard styling</span>
            </div>
            <Switch
              checked={ui.dynamicTheme}
              onChange={(v) => uiStore.setDynamicTheme(v)}
              aria-label="Dynamic theme"
            />
          </div>
          <div className="flex items-center gap-4 rounded-r2 px-1.5 py-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm text-ink">UI scale</span>
              <span className="text-xs text-mute">Zoom the whole interface</span>
            </div>
            <SelectField
              aria-label="UI scale"
              value={scale}
              options={UI_SCALES.map((s) => `${Math.round(s * 100)}%`)}
              onChange={(v) => uiStore.setUiScale((parseInt(v, 10) / 100) as UiScale)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export function GeneralSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  const g = payload.settings.general

  return (
    <>
      {/* Untitled: the page label in the header masthead already says "General", and this
          section is the whole page (user-directed, 2026-08-02). */}
      <SettingsSection>
        <AppearanceRow />
        {/* No "Confirm case delete" row (user-directed, 2026-08-21): deleting a case is
            irreversible and now always asks. A switch that turns a destructive confirmation off
            is a setting whose only reachable state is the dangerous one. */}
        {/* No "Similar past cases" row either — it moved to Settings → Defect corpus and became
            the general related-search switch (`relatedSearchOnOpen` + `relatedIncludeLocalCases`),
            which is where the corpora it searches alongside are configured. */}
        <SettingRow
          label="Keep running in the background"
          description="Closing the window leaves Argus in the tray so scheduled routines keep firing. On macOS Argus always keeps running, so scheduled routines fire regardless of this setting."
          isDefault={!g.keepAliveInBackground}
          onReset={() => void settingsStore.patch({ general: { keepAliveInBackground: null } })}
        >
          <Switch
            checked={g.keepAliveInBackground}
            onChange={(v) => void settingsStore.patch({ general: { keepAliveInBackground: v } })}
            aria-label="Keep running in the background"
          />
        </SettingRow>
        <DefaultReposRow repos={g.defaultRepos} />
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
