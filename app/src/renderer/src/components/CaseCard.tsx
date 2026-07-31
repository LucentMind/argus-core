import type { CaseRecord, CaseStatus } from '../../../shared/types'
import { formatSyncRecency, type ActionItem } from '../../../shared/triage'
import type { PrRollup } from '../../../shared/prStatus'
import { Card, Chip, IconBtn } from './ui'
import { PrRollupDot } from './PrRollupDot'
import { StatusDot } from './StatusDot'
import { railTier } from '../lib/priorityRail'
import { Download, Trash2 } from 'lucide-react'

/** Status colour as a text-* class: StatusDot fills from currentColor, and the word beside it
 *  takes the same class, so dot and label can never disagree. */
const STATUS_COLOR: Record<CaseStatus, string> = {
  open: 'text-signal',
  analyzing: 'text-defect',
  'rca-drafted': 'text-review',
  closed: 'text-mute'
}

/** Display form. The DB values are kebab/lowercase; the card is prose. */
const STATUS_WORD: Record<CaseStatus, string> = {
  open: 'Open',
  analyzing: 'Analyzing',
  'rca-drafted': 'RCA drafted',
  closed: 'Closed'
}

function statusLabel(c: CaseRecord): string {
  // The resolution stays in its stored lowercase form — it is a slug (`wont-fix`), not a sentence.
  return c.status === 'closed' && c.resolution ? `Closed · ${c.resolution}` : STATUS_WORD[c.status]
}

/** Action-item tones reuse the existing chip vocabulary — no new colors. */
const ITEM_TONE: Record<ActionItem['kind'], 'danger' | 'signal' | 'defect' | 'neutral'> = {
  'sync-error': 'danger',
  status: 'signal',
  comments: 'defect',
  attachments: 'defect',
  stale: 'neutral',
  idle: 'neutral'
}

export function CaseCard({
  c,
  onOpen,
  onExport,
  onDelete,
  note,
  prRollup,
  dynamic = false,
  index = 0
}: {
  c: CaseRecord
  onOpen: (slug: string) => void
  onExport: (slug: string) => void
  onDelete: (slug: string) => void
  note: { text: string; danger: boolean } | null
  /** Cached CI rollup for this case's bound PR. Absent when the case has no PR — the dashboard
   *  reads the cache and passes only what it has, so the card never fetches anything itself. */
  prRollup?: PrRollup
  /** Dynamic-theme skin: glass container, staggered entrance, priority rail. */
  dynamic?: boolean
  /** Grid position — drives the entrance stagger delay in dynamic mode. */
  index?: number
}): React.JSX.Element {
  const actions = c.actionItems.filter((i) => i.severity === 'action')
  // `stale` is deliberately dropped: the footer below now states sync recency
  // for EVERY linked case, in the same words and the same muted style, so the
  // chip would render the identical fact twice past day 7. The item still
  // exists in the model — triageRank uses it to sort neglected cases up.
  const infos = c.actionItems.filter((i) => i.severity === 'info' && i.kind !== 'stale')
  const tier = railTier(c.jiraPriority)
  // Rail = needs attention (the mock's has-unread semantics), not importance: a dashboard of
  // uniformly-railed cards says nothing.
  const showRail = tier !== null && actions.length > 0
  const recency = c.jiraKey && c.jiraSyncedAt ? formatSyncRecency(c.jiraSyncedAt) : null

  return (
    <Card
      onClick={() => onOpen(c.slug)}
      variant={dynamic ? 'glass' : 'default'}
      style={dynamic ? ({ '--d': `${50 + index * 40}ms` } as React.CSSProperties) : undefined}
      className="group relative flex min-h-[186px] flex-col gap-2 overflow-hidden p-4"
    >
      {showRail && (
        <i data-testid="priority-rail" data-tier={tier} aria-hidden="true" className="gc-rail" />
      )}
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-sm text-defect">{c.slug}</span>
          {c.jiraPriority && <Chip tone="neutral">{c.jiraPriority}</Chip>}
          {prRollup && <PrRollupDot rollup={prRollup} />}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <IconBtn
            aria-label={`Export ${c.slug}`}
            title="Export case"
            className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation() // the Card itself opens the case
              onExport(c.slug)
            }}
          >
            <Download size={14} />
          </IconBtn>
          <IconBtn
            aria-label={`Delete ${c.slug}`}
            title="Delete case"
            className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation() // the Card itself opens the case
              onDelete(c.slug)
            }}
          >
            <Trash2 size={14} />
          </IconBtn>
          <span className={`flex items-center gap-1.5 text-xs ${STATUS_COLOR[c.status]}`}>
            <StatusDot color={STATUS_COLOR[c.status]} />
            {statusLabel(c)}
          </span>
        </span>
      </div>
      <h2
        data-testid="case-title"
        title={c.title}
        className="line-clamp-2 text-[17px] leading-snug font-normal text-ink"
      >
        {c.title}
      </h2>
      {actions.length + infos.length > 0 && (
        <div data-testid="action-items" className="flex flex-wrap items-center gap-1.5">
          {actions.map((i) => (
            <Chip key={i.kind} tone={ITEM_TONE[i.kind]}>
              {i.label}
            </Chip>
          ))}
          {infos.map((i) => (
            <span key={i.kind} className="text-xs text-mute">
              {i.label}
            </span>
          ))}
        </div>
      )}
      <div className="mt-auto text-xs text-mute">
        {note ? (
          <span className={`truncate ${note.danger ? 'text-danger' : ''}`} title={note.text}>
            {note.text}
          </span>
        ) : (
          <>
            {/* Priority now lives in the top-row pill — stating it here too would repeat it. */}
            {c.jiraKey ?? 'no ticket'} · updated {new Date(c.updatedAt).toLocaleDateString()}
            {recency ? ` · ${recency}` : ''}
          </>
        )}
      </div>
    </Card>
  )
}
