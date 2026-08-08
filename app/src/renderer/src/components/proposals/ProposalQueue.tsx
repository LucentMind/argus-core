import { Fragment } from 'react'
import { Check, Zap, BookOpen, FileText, type LucideIcon } from 'lucide-react'
import { PROPOSAL_TYPE_LABELS } from '../../../../shared/proposals'
import type { ProposalType } from '../../../../shared/proposals'

export interface QueueEntry {
  kind: 'pending' | 'accepted'
  file: string
  title: string
  caseSlug: string
  date: string
  target: string
  type: ProposalType
  isNew: boolean
  locked: boolean
  previouslyReviewed: boolean
}

// skill = signal, reference/recipe = analytics, summary = review — the accent
// families the rest of the app already uses for these asset kinds.
const TYPE_ICON: Record<ProposalType, { Icon: LucideIcon; cls: string }> = {
  'skill-new': { Icon: Zap, cls: 'bg-signal/15 text-signal' },
  'skill-edit': { Icon: Zap, cls: 'bg-signal/15 text-signal' },
  'reference-edit': { Icon: BookOpen, cls: 'bg-analytics/15 text-analytics' },
  recipe: { Icon: BookOpen, cls: 'bg-analytics/15 text-analytics' },
  'case-summary': { Icon: FileText, cls: 'bg-review/15 text-review' }
}

export function ProposalQueue({
  entries,
  pendingCount,
  typesPresent,
  countByType,
  activeTypes,
  onToggleType,
  selectedFile,
  onSelect
}: {
  entries: QueueEntry[]
  pendingCount: number
  typesPresent: ProposalType[]
  countByType: Partial<Record<ProposalType, number>>
  activeTypes: ReadonlySet<ProposalType>
  onToggleType: (t: ProposalType) => void
  selectedFile: string | null
  onSelect: (file: string) => void
}): React.JSX.Element {
  return (
    <aside className="flex min-h-0 w-72 shrink-0 flex-col border-r border-hair">
      <div className="flex items-baseline gap-2 border-b border-hair px-4 py-3">
        <span className="text-sm font-medium text-ink">Proposals</span>
        <span className="text-xs text-mute">{pendingCount} pending</span>
      </div>
      {typesPresent.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-hair px-3 py-2">
          {typesPresent.map((t) => (
            <button
              key={t}
              aria-pressed={activeTypes.has(t)}
              aria-label={`Filter ${PROPOSAL_TYPE_LABELS[t]}`}
              onClick={() => onToggleType(t)}
              className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                activeTypes.has(t)
                  ? 'border-signal text-ink'
                  : 'border-hair text-dim hover:text-ink'
              }`}
            >
              {PROPOSAL_TYPE_LABELS[t]} · {countByType[t] ?? 0}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {entries.map((e, i) => {
          const { Icon, cls } = TYPE_ICON[e.type]
          const selected = e.file === selectedFile
          const caseHeader = i === 0 || entries[i - 1].caseSlug !== e.caseSlug
          return (
            <Fragment key={e.file}>
              {caseHeader && (
                <div className="sticky top-0 z-10 flex items-baseline gap-1.5 bg-panel px-4 pb-1 pt-3">
                  <span className="text-[10px] uppercase tracking-wide text-mute">Case</span>
                  <span className="font-mono text-xs text-dim">{e.caseSlug}</span>
                </div>
              )}
              <button
                aria-label={`Select proposal ${e.title}`}
                aria-current={selected ? 'true' : undefined}
                onClick={() => onSelect(e.file)}
                className={`flex w-full items-start gap-2.5 border-l-2 px-4 py-2 text-left transition-colors ${
                  selected ? 'border-signal bg-hi' : 'border-transparent hover:bg-hair'
                }`}
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-r1 ${
                    e.kind === 'accepted' ? 'bg-review/15 text-review' : cls
                  }`}
                >
                  {e.kind === 'accepted' ? (
                    <Check size={12} strokeWidth={2} />
                  ) : (
                    <Icon size={12} strokeWidth={1.75} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-ink">{e.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-mute">
                    <span className="truncate">
                      {PROPOSAL_TYPE_LABELS[e.type]}
                      {e.target ? ` → ${e.target}` : ''}
                    </span>
                    {e.kind === 'accepted' && <QueueBadge tone="review">accepted</QueueBadge>}
                    {e.isNew && <QueueBadge tone="review">new</QueueBadge>}
                    {e.locked && <QueueBadge tone="defect">pack</QueueBadge>}
                    {e.previouslyReviewed && <QueueBadge tone="neutral">seen before</QueueBadge>}
                  </span>
                </span>
              </button>
            </Fragment>
          )
        })}
      </div>
    </aside>
  )
}

function QueueBadge({
  tone,
  children
}: {
  tone: 'review' | 'defect' | 'neutral'
  children: React.ReactNode
}): React.JSX.Element {
  const cls =
    tone === 'review'
      ? 'border-review/40 text-review'
      : tone === 'defect'
        ? 'border-defect/40 text-defect'
        : 'border-hair2 text-dim'
  return (
    <span className={`rounded-full border px-1.5 text-[10px] leading-4 ${cls}`}>{children}</span>
  )
}
