import { useState } from 'react'
import { RefreshCw, Pencil, Trash2 } from 'lucide-react'
import { SettingsSection } from './settingsLayout'
import { Btn, Card, Chip, IconBtn } from '../ui'
import { ModalShell } from '../ModalShell'
import { SpaceDialog } from '../references/SpaceDialog'
import { SyncReportView } from '../references/SyncReportView'
import { confirm } from '../../lib/confirmStore'
import { useRefSyncPayload, referenceSyncStore } from '../../lib/referenceSyncStore'
import { useConnectorsPayload } from '../../lib/connectorsStore'
import type { SpaceConfig, SyncReport } from '../../../../shared/referenceSync'

/** Atlassian (Rovo preset) OAuth state, checked client-side before the user hits Sync. */
function atlassianTokenWarning(connectors: ReturnType<typeof useConnectorsPayload>): string | null {
  if (!connectors) return null
  const entry = Object.entries(connectors.connectors).find(([, inst]) => inst.preset === 'rovo')
  if (!entry)
    return 'No Atlassian connector configured — add the Atlassian Rovo preset in Settings → Connectors.'
  const [instanceId] = entry
  const restError = connectors.rest[instanceId]
  if (restError) return `Atlassian authorization problem: ${restError}`
  if (connectors.oauth[instanceId] !== 'authorized') {
    return 'Authorize the Atlassian connector (Settings → Connectors) before syncing.'
  }
  return null
}

export function ConfluenceSpaces(): React.JSX.Element {
  const payload = useRefSyncPayload()
  const connectors = useConnectorsPayload()
  const tokenWarning = atlassianTokenWarning(connectors)
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
      {tokenWarning && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-r2 border border-review/40 bg-review/10 px-3 py-2 text-xs text-review"
        >
          <span className="flex-1">{tokenWarning}</span>
        </div>
      )}
      <SettingsSection title="Confluence spaces">
        {(payload?.cards ?? []).map((card) => {
          const space = payload?.config.spaces.find((s) => s.key === card.key)
          return (
            <Card key={card.key} className="flex items-center gap-3 p-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{card.name}</span>
                  <span className="text-xs text-faint">{card.key}</span>
                  {card.stale ? (
                    <Chip tone="danger">stale</Chip>
                  ) : (
                    <Chip tone="review">synced</Chip>
                  )}
                  {card.driftTargets.length > 0 && (
                    <Chip tone="neutral">{card.driftTargets.length} drifted</Chip>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-dim">
                  <span>
                    {card.pageCount ?? '—'} pages ·{' '}
                    {card.lastSyncedAt
                      ? `last sync ${card.lastSyncedAt.slice(0, 10)}`
                      : 'never synced'}
                  </span>
                  <IconBtn
                    aria-label={`sync · ${card.key}`}
                    title={tokenWarning ?? 'Sync space'}
                    disabled={syncing === card.key || Boolean(tokenWarning)}
                    onClick={() => void syncNow(card.key)}
                    className="h-5 w-5"
                  >
                    <RefreshCw size={12} className={syncing === card.key ? 'animate-spin' : ''} />
                  </IconBtn>
                </div>
                {syncErrors[card.key] && (
                  <div role="alert" className="text-xs text-danger">
                    {syncErrors[card.key]}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <IconBtn
                  aria-label={`manage · ${card.key}`}
                  title="Manage selection"
                  onClick={() => space && setDialog({ existing: space })}
                >
                  <Pencil size={14} />
                </IconBtn>
                <IconBtn
                  aria-label={`remove · ${card.key}`}
                  title="Remove space"
                  className="hover:text-danger"
                  onClick={() => {
                    void confirm({
                      title: `Remove ${card.key}?`,
                      message: 'Synced reference files stay.',
                      confirmLabel: 'Remove',
                      danger: true
                    }).then((ok) => {
                      if (ok) {
                        void window.argus.refsync
                          .removeSpace(card.key)
                          .then((p) => referenceSyncStore.set(p))
                      }
                    })
                  }}
                >
                  <Trash2 size={14} />
                </IconBtn>
              </div>
            </Card>
          )
        })}
        {(payload?.cards ?? []).length === 0 && (
          <div className="px-3 py-2 text-xs text-faint">
            No spaces yet — add one to start syncing references.
          </div>
        )}
      </SettingsSection>
      <div>
        <Btn variant="primary" onClick={() => setDialog({})}>
          Add Confluence space
        </Btn>
      </div>
      {dialog && <SpaceDialog existing={dialog.existing} onClose={() => setDialog(null)} />}
      {report && (
        <ModalShell
          title={`Sync report · ${report.spaceKey}`}
          ariaLabel={`sync report · ${report.spaceKey}`}
          onClose={() => setReport(null)}
          className="max-h-[85vh] w-[42rem]"
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <SyncReportView report={report} />
          </div>
        </ModalShell>
      )}
    </div>
  )
}
