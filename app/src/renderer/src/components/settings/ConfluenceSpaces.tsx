import { useEffect, useState } from 'react'
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

/**
 * Confluence sync is off unless something asked for it (user-directed, 2026-08-08).
 *
 * A synced space only produces anything useful once a routing rule says which reference file each
 * page's content belongs in — unrouted pages are reported and dropped, never written. Packs are
 * where those rules come from (`referenceRouting` in `argus-pack.json`), so a workspace with no
 * pack declaring any has nothing for the feature to do, and the section was pure noise on the Team
 * page for every such install.
 *
 * `null` while the check is in flight, so the section does not flash in and then vanish (or the
 * reverse) on every mount of the Team page.
 *
 * A failed IPC call resolves to "enabled". The rule is meant to hide an inapplicable feature, not
 * to be a gate that a transient failure can slam on configuration the user already depends on.
 */
// Not a component, but it belongs with the section whose visibility it decides — and its one
// consumer (HivemindSettings) needs it to drop the empty grid column too, so it cannot be private.
// eslint-disable-next-line react-refresh/only-export-components
export function useConfluenceEnabled(): boolean {
  const [declared, setDeclared] = useState<boolean | null>(null)
  // Reads the shared store mirror, not a second IPC call — so this hook costs one `packs`
  // round trip and nothing else, wherever it is mounted.
  const payload = useRefSyncPayload()
  useEffect(() => {
    let live = true
    void window.argus.packs.referenceRouting().then(
      (rules) => live && setDeclared(rules.length > 0),
      (err) => {
        console.warn(`[refsync] referenceRouting failed: ${(err as Error).message}`)
        if (live) setDeclared(true)
      }
    )
    return () => {
      live = false
    }
  }, [])
  // Spaces already configured keep the section regardless of what any pack declares: the rule is
  // meant to keep an inapplicable feature out of the way, and hiding a space someone set up (with
  // its sync history and its Remove button) would strand it, not tidy it.
  if ((payload?.config.spaces.length ?? 0) > 0) return true
  // `null` = still checking. Hidden until it resolves, so the section fades in rather than
  // appearing and then being yanked away on the answer.
  return declared === true
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
      <SettingsSection
        title="Confluence"
        subtitle="Spaces synced into your references, and kept current."
      >
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
                    size="xs"
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
