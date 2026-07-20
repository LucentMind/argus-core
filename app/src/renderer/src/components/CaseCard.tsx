import type { CaseRecord, CaseStatus } from '../../../shared/types'
import { formatSyncRecency, type ActionItem } from '../../../shared/triage'
import { Card, Chip, IconBtn } from './ui'
import { Download, Trash2 } from 'lucide-react'

const STATUS_TONE: Record<CaseStatus, 'signal' | 'defect' | 'review' | 'neutral'> = {
  open: 'signal',
  analyzing: 'defect',
  'rca-drafted': 'review',
  closed: 'neutral'
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
  note
}: {
  c: CaseRecord
  onOpen: (slug: string) => void
  onExport: (slug: string) => void
  onDelete: (slug: string) => void
  note: { text: string; danger: boolean } | null
}): React.JSX.Element {
  const actions = c.actionItems.filter((i) => i.severity === 'action')
  // `stale` is deliberately dropped: the footer below now states sync recency
  // for EVERY linked case, in the same words and the same muted style, so the
  // chip would render the identical fact twice past day 7. The item still
  // exists in the model — triageRank uses it to sort neglected cases up.
  const infos = c.actionItems.filter((i) => i.severity === 'info' && i.kind !== 'stale')
  const recency = c.jiraKey && c.jiraSyncedAt ? formatSyncRecency(c.jiraSyncedAt) : null

  return (
    <Card onClick={() => onOpen(c.slug)} className="group flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm text-defect">{c.slug}</span>
        <span className="flex items-center gap-1.5">
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
          <Chip tone={STATUS_TONE[c.status]}>
            {c.status === 'closed' && c.resolution ? `closed · ${c.resolution}` : c.status}
          </Chip>
        </span>
      </div>
      <div className="text-sm text-ink">{c.title}</div>
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
            {c.jiraKey ?? 'no ticket'}
            {c.jiraPriority ? ` · ${c.jiraPriority}` : ''} · updated{' '}
            {new Date(c.updatedAt).toLocaleDateString()}
            {recency ? ` · ${recency}` : ''}
          </>
        )}
      </div>
    </Card>
  )
}
