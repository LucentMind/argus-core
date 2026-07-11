import { useState } from 'react'
import { SettingsSection, SettingRow } from './settingsLayout'
import { Btn, Card, Chip, MenuButton } from '../ui'
import { SpaceDialog } from '../references/SpaceDialog'
import { SyncReportView } from '../references/SyncReportView'
import { useRefSyncPayload, referenceSyncStore } from '../../lib/referenceSyncStore'
import type { SpaceConfig, SyncReport } from '../../../../shared/referenceSync'

/**
 * References settings page (spec §3.2 step 5): Confluence space cards (sync,
 * manage selection, remove) plus a reference-file list showing per-file
 * staleness. Loads via the shared referenceSyncStore mirror (Task 8).
 */
export function ReferencesSettings(): React.JSX.Element {
  const payload = useRefSyncPayload()
  const [dialog, setDialog] = useState<null | { existing?: SpaceConfig }>(null)
  const [report, setReport] = useState<SyncReport | null>(null)
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({})
  const [syncing, setSyncing] = useState<string | null>(null)

  const syncNow = async (key: string): Promise<void> => {
    setSyncing(key)
    setSyncErrors((e) => ({ ...e, [key]: '' }))
    try {
      const r = await window.argus.refsync.sync(key)
      if (r.ok) setReport(r.value)
      else setSyncErrors((e) => ({ ...e, [key]: r.message }))
    } finally {
      setSyncing(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {payload?.loadError && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          <span className="flex-1">
            config/reference-sync.json could not be parsed — using defaults. ({payload.loadError})
          </span>
        </div>
      )}
      <SettingsSection title="Confluence spaces">
        {(payload?.cards ?? []).map((card) => {
          const space = payload?.config.spaces.find((s) => s.key === card.key)
          return (
            <Card key={card.key} className="flex flex-col gap-2 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{card.name}</span>
                <span className="text-xs text-faint">{card.key}</span>
                {card.stale ? <Chip tone="danger">stale</Chip> : <Chip tone="review">synced</Chip>}
                {card.driftTargets.length > 0 && (
                  <Chip tone="neutral">{card.driftTargets.length} drifted</Chip>
                )}
                <span className="flex-1" />
                <Btn
                  variant="outline"
                  aria-label={`sync · ${card.key}`}
                  disabled={syncing === card.key}
                  onClick={() => void syncNow(card.key)}
                >
                  {syncing === card.key ? 'Syncing…' : 'Sync now'}
                </Btn>
                <Btn
                  variant="ghost"
                  aria-label={`manage · ${card.key}`}
                  onClick={() => space && setDialog({ existing: space })}
                >
                  Manage selection
                </Btn>
                <MenuButton
                  label="⋯"
                  aria-label={`space menu · ${card.key}`}
                  items={[
                    {
                      label: 'Remove space',
                      tone: 'danger',
                      onSelect: () => {
                        if (window.confirm(`Remove ${card.key}? Synced reference files stay.`)) {
                          void window.argus.refsync
                            .removeSpace(card.key)
                            .then((p) => referenceSyncStore.set(p))
                        }
                      }
                    }
                  ]}
                />
              </div>
              <div className="text-xs text-dim">
                {card.pageCount ?? '—'} pages ·{' '}
                {card.lastSyncedAt ? `last sync ${card.lastSyncedAt.slice(0, 10)}` : 'never synced'}
              </div>
              {syncErrors[card.key] && (
                <div role="alert" className="text-xs text-danger">
                  {syncErrors[card.key]}
                </div>
              )}
            </Card>
          )
        })}
        {(payload?.cards ?? []).length === 0 && (
          <div className="px-3 py-2 text-xs text-faint">
            No spaces yet — add one to start syncing references.
          </div>
        )}
        <div className="px-3 py-2">
          <Btn variant="primary" onClick={() => setDialog({})}>
            Add Confluence space
          </Btn>
        </div>
      </SettingsSection>
      <SettingsSection title="Reference files">
        {(payload?.references ?? []).map((r) => (
          <SettingRow
            key={r.file}
            label={r.file}
            description={r.lastSynced ? `last synced ${r.lastSynced.slice(0, 10)}` : 'never synced'}
          >
            <div className="flex items-center gap-2">
              {r.tier && <Chip tone="neutral">{r.tier}</Chip>}
              {r.stale && <Chip tone="danger">stale</Chip>}
            </div>
          </SettingRow>
        ))}
      </SettingsSection>
      {dialog && <SpaceDialog existing={dialog.existing} onClose={() => setDialog(null)} />}
      {report && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
          onClick={() => setReport(null)}
        >
          <div
            role="dialog"
            aria-label={`sync report · ${report.spaceKey}`}
            className="flex max-h-[85vh] w-[42rem] flex-col gap-3 overflow-y-auto rounded-r4 border border-hair2 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <SyncReportView report={report} onClose={() => setReport(null)} />
          </div>
        </div>
      )}
    </div>
  )
}
