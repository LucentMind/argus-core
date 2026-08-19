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
  /** The proposal carries at least one executable sibling. Shown on the CARD, not only in the
   *  detail pane: a reviewer scanning the inbox must not meet the risk surface below the fold. */
  hasExec: boolean
}

/**
 * The three kinds of thing a proposal can be, as the rows already draw them: skill = signal,
 * reference = analytics, summary = review — the accent families the rest of the app uses
 * for these asset kinds.
 *
 * This is also the filter set (user-directed, 2026-08-08). It used to be one chip per
 * `ProposalType`, i.e. five, which split "Skill · new" from "Skill · edit" and "Reference" from
 * "Recipe" — distinctions the row subtitles already make and that nobody filters by. Three chips,
 * one per icon, is the whole control now; the exact type still shows on every row.
 */
const TYPE_GROUPS = [
  {
    key: 'skill',
    label: 'Skill',
    Icon: Zap,
    badge: 'bg-signal/15 text-signal',
    ink: 'text-signal'
  },
  {
    key: 'reference',
    label: 'Reference',
    Icon: BookOpen,
    badge: 'bg-analytics/15 text-analytics',
    ink: 'text-analytics'
  },
  {
    key: 'summary',
    label: 'Case summary',
    Icon: FileText,
    badge: 'bg-review/15 text-review',
    ink: 'text-review'
  }
] as const satisfies readonly {
  key: string
  label: string
  Icon: LucideIcon
  badge: string
  ink: string
}[]

type GroupKey = (typeof TYPE_GROUPS)[number]['key']

const GROUP_OF: Record<ProposalType, GroupKey> = {
  'skill-new': 'skill',
  'skill-edit': 'skill',
  'reference-edit': 'reference',
  'case-summary': 'summary'
}

/** The row icon comes from the same table as the filter chip — one source of truth for
 *  "what kind of thing is this", so the chip and the rows it filters can never disagree. */
const TYPE_ICON: Record<ProposalType, { Icon: LucideIcon; cls: string }> = Object.fromEntries(
  (Object.keys(GROUP_OF) as ProposalType[]).map((t) => {
    const g = TYPE_GROUPS.find((x) => x.key === GROUP_OF[t])!
    return [t, { Icon: g.Icon, cls: g.badge }]
  })
) as Record<ProposalType, { Icon: LucideIcon; cls: string }>

export function ProposalQueue({
  entries,
  typesPresent,
  countByType,
  activeTypes,
  onToggleTypes,
  selectedFile,
  onSelect
}: {
  entries: QueueEntry[]
  typesPresent: ProposalType[]
  countByType: Partial<Record<ProposalType, number>>
  activeTypes: ReadonlySet<ProposalType>
  /** Toggling a chip moves every type in its group at once — the filter is per group, the
   *  state it drives is still per type (the caller filters rows by `ProposalType`). */
  onToggleTypes: (types: readonly ProposalType[], active: boolean) => void
  selectedFile: string | null
  onSelect: (file: string) => void
}): React.JSX.Element {
  // Only groups with something in the queue get a chip, same rule the per-type chips had.
  const groups = TYPE_GROUPS.map((g) => {
    const types = typesPresent.filter((t) => GROUP_OF[t] === g.key)
    return {
      ...g,
      types,
      count: types.reduce((n, t) => n + (countByType[t] ?? 0), 0),
      // `some`, not `every`: a group is "on" as soon as any of its types is filtered in, which is
      // the only state the chip can produce (it sets or clears the whole group together) and is
      // also the honest reading of a stale set left over from a type that has since drained.
      active: types.some((t) => activeTypes.has(t))
    }
  }).filter((g) => g.types.length > 0)

  return (
    // No "Proposals · N pending" header of its own (user-directed, 2026-08-08): the top bar
    // carries exactly that, a few pixels above, ever since this view stopped drawing its own
    // title row. The filter chips are this column's first row now, and the queue gets the
    // height back.
    <aside className="flex min-h-0 w-72 shrink-0 flex-col border-r border-hair">
      {groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-hair px-3 py-2">
          {groups.map((g) => (
            <button
              key={g.key}
              aria-pressed={g.active}
              aria-label={`Filter ${g.label}`}
              onClick={() => onToggleTypes(g.types, !g.active)}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                g.active ? 'border-signal text-ink' : 'border-hair text-dim hover:text-ink'
              }`}
            >
              {/* The icon carries the accent colour whatever the chip's own state, so a chip is
                  identifiable by its family before you read the label — the rows use the same
                  pairing. */}
              <g.Icon size={12} strokeWidth={1.75} className={g.ink} />
              {g.label} · {g.count}
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
                    {/* Matches the row's own badge species — every other marker here is a
                        QueueBadge (rounded-full, 10px, borderless-background); `Chip` is
                        rounded-r1/uppercase/bg-hair-50 with taller padding and reads as a
                        different, row-height-adding element (user-directed). */}
                    {e.hasExec && <QueueBadge tone="review">exec</QueueBadge>}
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
