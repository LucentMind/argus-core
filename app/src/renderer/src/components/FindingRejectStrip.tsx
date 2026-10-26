import { useState } from 'react'
import {
  FINDING_REJECT_LABELS,
  FINDING_REJECT_TAGS,
  type FindingRejectReason
} from '../../../shared/observability'
import { Btn } from './ui'

/**
 * The optional "why?" under a finding the user just rejected (spec 2026-10-25 §4.4):
 * ProposalDetail's reject bar, reduced. The reject has ALREADY happened — nothing here is
 * required, and closing it (Skip, Escape, clicking elsewhere) leaves the finding rejected and
 * unlabelled. Chip → that tag (+ the note if typed); Enter in the note or the Reject button →
 * `other` + note.
 */
export function FindingRejectStrip({
  onPick,
  onSkip
}: {
  onPick: (reason: FindingRejectReason) => void
  onSkip: () => void
}): React.JSX.Element {
  const [note, setNote] = useState('')
  const trimmed = note.trim()
  const withNote = (tag: FindingRejectReason['tag']): FindingRejectReason =>
    trimmed ? { tag, note: trimmed } : { tag }
  return (
    <div
      data-testid="finding-reject-strip"
      className="flex flex-wrap items-center gap-1.5 border-t border-hair px-3 py-1.5"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onSkip()
        }
      }}
    >
      <span className="text-[10.5px] text-mute">Why? (optional)</span>
      {FINDING_REJECT_TAGS.map((tag) => (
        <button
          key={tag}
          type="button"
          aria-label={`Reject as ${tag}`}
          className="rounded-full border border-hair px-1.5 py-0.5 text-[10.5px] text-dim hover:text-ink"
          onClick={() => onPick(withNote(tag))}
        >
          {FINDING_REJECT_LABELS[tag]}
        </button>
      ))}
      <input
        aria-label="Reject note"
        placeholder="or write your own reason"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && trimmed) {
            e.preventDefault()
            onPick({ tag: 'other', note: trimmed })
          }
        }}
        className="min-w-32 flex-1 rounded-r2 border border-hair bg-transparent px-2 py-0.5 text-[10.5px] text-ink"
      />
      {trimmed ? (
        <Btn
          variant="dangerSolid"
          aria-label="Reject with this note"
          onClick={() => onPick({ tag: 'other', note: trimmed })}
        >
          Reject
        </Btn>
      ) : (
        <Btn variant="ghost" aria-label="Skip" onClick={onSkip}>
          Skip
        </Btn>
      )}
    </div>
  )
}
