import type { CaseRecord, CaseStatus } from '../../../shared/types'
import type { ActionItem } from '../../../shared/triage'
import type { PrRollup } from '../../../shared/prStatus'
import { Card, Chip, IconBtn } from './ui'
import { PrRollupIcon } from './PrRollupDot'
import { StatusDot } from './StatusDot'
import { SyncBadge } from './SyncBadge'
import { railTier } from '../lib/priorityRail'
import { priorityIconFor } from '../lib/priorityIcon'
import { STATUS_WORD } from '../lib/caseStatus'
import { Download, Trash2, MessageSquare, Paperclip } from 'lucide-react'

/** Status colour as a text-* class: StatusDot fills from currentColor, and the word beside it
 *  takes the same class, so dot and label can never disagree. */
const STATUS_COLOR: Record<CaseStatus, string> = {
  open: 'text-signal',
  analyzing: 'text-defect',
  'rca-drafted': 'text-review',
  closed: 'text-mute'
}

function statusLabel(c: CaseRecord): string {
  // The resolution stays in its stored lowercase form — it is a slug (`wont-fix`), not a sentence.
  return c.status === 'closed' && c.resolution ? `Closed · ${c.resolution}` : STATUS_WORD[c.status]
}

/** Kinds that carry a magnitude — these leave the chip row for the footer's metric strip. */
const METRIC_KIND = { comments: MessageSquare, attachments: Paperclip } as const

/** Chip tone for the kinds that stay chips. Comments/attachments are gone from this map: they
 *  are metrics now, and always amber — a red count would say "broken" where the truth is
 *  "somebody replied". Red is reserved for sync failure. */
const ITEM_TONE: Record<
  'sync-error' | 'status' | 'stale' | 'idle',
  'danger' | 'signal' | 'neutral'
> = {
  'sync-error': 'danger',
  status: 'signal',
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
  /** Dynamic-theme skin: glass container, staggered entrance. */
  dynamic?: boolean
  /** Grid position — drives the entrance stagger delay in dynamic mode. */
  index?: number
}): React.JSX.Element {
  const actions = c.actionItems.filter((i) => i.severity === 'action')
  const metrics = actions.filter(
    (i): i is ActionItem & { kind: keyof typeof METRIC_KIND; count: number } =>
      i.kind in METRIC_KIND && typeof i.count === 'number' && i.count > 0
  )
  const chips = actions.filter((i) => !(metrics as ActionItem[]).includes(i))
  // `stale` is deliberately dropped: the footer's sync badge states recency for EVERY linked
  // case, so the chip would render the identical fact twice past day 7. The item still exists
  // in the model — triageRank uses it to sort neglected cases up.
  const infos = c.actionItems.filter((i) => i.severity === 'info' && i.kind !== 'stale')
  const tier = railTier(c.jiraPriority)
  const priority = priorityIconFor(c.jiraPriority)
  // Rail = needs attention (the mock's has-unread semantics), not importance: a dashboard of
  // uniformly-railed cards says nothing.
  const showRail = tier !== null && actions.length > 0

  return (
    <Card
      onClick={() => onOpen(c.slug)}
      variant={dynamic ? 'glass' : 'default'}
      style={dynamic ? ({ '--d': `${50 + index * 40}ms` } as React.CSSProperties) : undefined}
      className="group relative flex min-h-[158px] flex-col gap-1.5 overflow-hidden p-4"
    >
      {showRail && (
        <i data-testid="priority-rail" data-tier={tier} aria-hidden="true" className="gc-rail" />
      )}
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-sm text-signal">{c.slug}</span>
          {/* Jira-style glyph where we recognise the scheme, the bare word where we don't —
              priority names are per-project, and an unmapped value must still be readable
              rather than silently vanishing. */}
          {priority ? (
            // The label and tooltip live on the wrapper, not the svg: lucide's prop type has no
            // `title`, and a glyph with no text needs an accessible name either way.
            <span
              data-testid="priority-icon"
              role="img"
              aria-label={`Priority: ${c.jiraPriority}`}
              title={c.jiraPriority!}
              className={`shrink-0 ${priority.className}`}
            >
              <priority.Icon size={15} strokeWidth={2.5} aria-hidden="true" />
            </span>
          ) : (
            c.jiraPriority && <Chip tone="neutral">{c.jiraPriority}</Chip>
          )}
        </span>
        <span className={`flex shrink-0 items-center gap-1.5 text-xs ${STATUS_COLOR[c.status]}`}>
          <StatusDot color={STATUS_COLOR[c.status]} />
          {statusLabel(c)}
        </span>
      </div>
      <h2
        data-testid="case-title"
        title={c.title}
        className="line-clamp-2 text-[17px] leading-snug font-normal text-ink"
      >
        {c.title}
      </h2>
      {chips.length + infos.length > 0 && (
        <div data-testid="action-items" className="flex flex-wrap items-center gap-1.5">
          {chips.map((i) => (
            <Chip key={i.kind} tone={ITEM_TONE[i.kind as keyof typeof ITEM_TONE]}>
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
      {note && (
        <div
          className={`truncate text-xs ${note.danger ? 'text-danger' : 'text-mute'}`}
          title={note.text}
        >
          {note.text}
        </div>
      )}
      <div className="mt-auto flex items-center gap-3 pt-1 text-xs text-mute">
        {metrics.map((i) => {
          const Glyph = METRIC_KIND[i.kind]
          return (
            <span
              key={i.kind}
              data-testid={`metric-${i.kind}`}
              title={i.label}
              className="flex items-center gap-1 text-defect"
            >
              <Glyph size={13} aria-hidden="true" />
              {i.count}
            </span>
          )
        })}
        {prRollup && <PrRollupIcon rollup={prRollup} />}
        <span className="ml-auto flex items-center gap-2">
          <SyncBadge c={c} />
          {/* Fixed width whether or not the icons are visible: revealing them on hover must not
              shove the sync badge sideways. */}
          <span
            data-testid="card-actions"
            className="flex w-[52px] shrink-0 items-center justify-end gap-1"
          >
            <IconBtn
              aria-label={`Export ${c.slug}`}
              title="Export case"
              size="sm"
              className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation() // the Card itself opens the case
                onExport(c.slug)
              }}
            >
              <Download size={13} />
            </IconBtn>
            <IconBtn
              aria-label={`Delete ${c.slug}`}
              title="Delete case"
              size="sm"
              className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation() // the Card itself opens the case
                onDelete(c.slug)
              }}
            >
              <Trash2 size={13} />
            </IconBtn>
          </span>
        </span>
      </div>
    </Card>
  )
}
