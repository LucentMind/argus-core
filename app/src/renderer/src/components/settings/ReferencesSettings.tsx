import { useEffect, useState, Fragment } from 'react'
import { Share2 } from 'lucide-react'
import { SettingsSection } from './settingsLayout'
import { Btn, Chip } from '../ui'
import { TierBadge } from './TierBadge'
import { ConfluenceSpaces } from './ConfluenceSpaces'
import { RefViewer } from '../references/RefViewer'
import { ProposalsBanner } from './ProposalsBanner'
import { SharePushDialog, PushReceiptChip } from './SharePushDialog'
import { useSharePush } from './useSharePush'
import { useRefSyncPayload } from '../../lib/referenceSyncStore'
import { PUSHABLE_TIERS } from '../../../../shared/trustTiers'
import type { ReferenceUsageRow } from '../../../../shared/observability'
import type { ProposalType } from '../../../../shared/proposals'

const REFERENCE_TYPES: readonly ProposalType[] = ['reference-edit', 'recipe']

/**
 * References settings page (spec §3.2 step 5): Confluence space cards (sync,
 * manage selection, remove) plus a searchable reference-file list showing
 * per-file staleness; rows open the in-app markdown viewer.
 */
export function ReferencesSettings({
  onReviewProposals
}: {
  onReviewProposals?: (types: readonly ProposalType[]) => void
} = {}): React.JSX.Element {
  const payload = useRefSyncPayload()
  const [viewer, setViewer] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // null = no active search (show all); otherwise the set of matching file names
  const [matches, setMatches] = useState<Set<string> | null>(null)
  const [usage, setUsage] = useState<Map<string, ReferenceUsageRow> | null>(null)
  const [sharing, setSharing] = useState<string | null>(null)
  const [sharePushing, setSharePushing] = useState(false)
  const { shareReady, shareTip, pushes, refresh: refreshShare } = useSharePush()

  useEffect(() => {
    let mounted = true
    void window.argus.usage
      .stats()
      .then((u) => {
        if (mounted) setUsage(new Map(u.references.map((r) => [r.relPath, r])))
      })
      .catch(() => undefined)
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!query.trim()) return
    let cancelled = false
    const t = setTimeout(() => {
      void window.argus.refsync.searchRefs(query).then((names) => {
        if (!cancelled) setMatches(new Set(names))
      })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query])

  // blank query = no active filter; stale `matches` are ignored rather than cleared in-effect
  const activeMatches = query.trim() ? matches : null

  const references = (payload?.references ?? []).filter(
    (r) => activeMatches === null || activeMatches.has(r.file)
  )

  return (
    <div className="flex flex-col gap-6">
      {onReviewProposals && (
        <ProposalsBanner
          types={REFERENCE_TYPES}
          noun="references"
          onReview={() => onReviewProposals(REFERENCE_TYPES)}
        />
      )}
      <ConfluenceSpaces />
      <SettingsSection title="Reference files">
        <div className="px-3 py-2">
          <input
            aria-label="search references"
            placeholder="Search file names and content…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-r2 bg-black/20 px-2 py-1 text-sm outline-none placeholder:text-faint"
          />
        </div>
        {references.map((r) => {
          const receipt = pushes[`reference/${r.file}`]
          const canShare = r.tier !== null && (PUSHABLE_TIERS as readonly string[]).includes(r.tier)
          return (
            <Fragment key={r.file}>
              <div className="flex w-full items-center gap-3 px-3 py-2 transition-colors hover:bg-hair">
                <button
                  aria-label={`open · ${r.file}`}
                  onClick={() => setViewer(r.file)}
                  className="flex min-w-0 flex-1 flex-col text-left"
                >
                  <span className="text-sm text-ink">{r.file}</span>
                  <span className="text-xs text-dim">
                    {r.lastSynced ? `last synced ${r.lastSynced.slice(0, 10)}` : 'never synced'}
                    {usage?.get(r.file) && (
                      <>
                        {' · '}
                        {usage.get(r.file)!.readCount === 0
                          ? 'never read'
                          : `${usage.get(r.file)!.readCount} reads · last ${usage.get(r.file)!.lastReadAt!.slice(0, 10)}`}
                      </>
                    )}
                  </span>
                </button>
                {r.tier && <TierBadge tier={r.tier} />}
                {r.stale && <Chip tone="danger">stale</Chip>}
                {receipt && <PushReceiptChip name={r.file} receipt={receipt} />}
                {canShare && (
                  <Btn
                    variant="outline"
                    aria-label={`Share ${r.file} to HiveMind`}
                    title={shareTip}
                    // sharePushing: opening another row's dialog would unmount an
                    // in-flight push and its PR URL would never be shown
                    disabled={!shareReady || sharePushing}
                    onClick={() => setSharing(sharing === r.file ? null : r.file)}
                  >
                    <Share2 size={13} aria-hidden="true" />
                    Share
                  </Btn>
                )}
              </div>
              {sharing === r.file && (
                <SharePushDialog
                  kind="reference"
                  name={r.file}
                  onClose={() => {
                    setSharing(null)
                    refreshShare()
                  }}
                  onBusyChange={setSharePushing}
                />
              )}
            </Fragment>
          )
        })}
        {references.length === 0 && (
          <div className="px-3 py-2 text-xs text-faint">
            {activeMatches === null
              ? "No reference files yet — references arrive from Confluence sync, your team's HiveMind, or accepted agent proposals."
              : 'No matches.'}
          </div>
        )}
      </SettingsSection>
      {viewer && <RefViewer file={viewer} onClose={() => setViewer(null)} />}
    </div>
  )
}
