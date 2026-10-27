import { useState, useSyncExternalStore } from 'react'
import { findingIdFromToolOutput } from '../../../shared/findingRef'
import { isInactiveFinding } from '../../../shared/findingTree'
import type { FindingRejectReason, FindingRole } from '../../../shared/observability'
import type { TranscriptItem } from '../lib/agentStore'
import type { CiteTarget } from '../lib/citations'
import { confirm } from '../lib/confirmStore'
import { findingsStore } from '../lib/findingsStore'
import { reposStore } from '../lib/reposStore'
import { FindingCard } from './FindingCard'
import { FindingRejectStrip } from './FindingRejectStrip'
import { ToolCallCard } from './ToolCallCard'

/**
 * A finding where the user is reading (spec 2026-10-26 §5.4, G1): the transcript item for an
 * `append_finding` or `update_finding` call renders the finding it recorded or changed — same
 * `FindingCard`, same store, same thumbs, reason strip and chain editors as the rail — instead of
 * a tool row whose whole output is "finding appended". Resolves the row by the `#<id>` in the
 * tool result; until the call completes, or when the id cannot be read (an error result, an
 * overridden wording without `#{id}`), it is the ordinary tool card — and nothing at all when
 * tool cards are hidden. Investigation findings only: a review finding's actions (Post / Apply)
 * need the rail's PR plumbing.
 */
export function InlineFinding({
  item,
  slug,
  sessionId,
  onCite,
  hidden
}: {
  item: Extract<TranscriptItem, { kind: 'tool' }>
  slug: string
  sessionId: number | null
  onCite: (cite: CiteTarget) => void
  /** `!showToolCalls`: hides the FALLBACK tool card; a resolved finding is always shown. */
  hidden: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const rows = useSyncExternalStore(
    (cb) => findingsStore.subscribe(cb),
    () => findingsStore.get(slug).rows
  )
  const repoNames = useSyncExternalStore(
    (cb) => reposStore.subscribe(cb),
    () => reposStore.get(slug)
  ).names
  const id = item.done && !item.isError ? findingIdFromToolOutput(item.outputPreview) : null
  const finding = id === null ? undefined : rows.find((f) => f.id === id)
  if (!finding || finding.mode !== 'investigation') {
    return hidden ? null : <ToolCallCard item={item} />
  }

  async function review(
    next: 'accepted' | 'rejected',
    reason?: FindingRejectReason
  ): Promise<void> {
    const row = await findingsStore.review(slug, finding!.id, next, reason)
    // A failed save must not discard the typed note: a reason pick that comes back null keeps
    // the strip open. Otherwise the strip is open only on a fresh reject with no reason yet.
    setRejecting(reason ? row === null : row?.reviewState === 'rejected')
  }

  /** A refusal (a loop, a second root cause…) is the card's own line of text, never a dialog. */
  async function edit(patch: {
    role?: FindingRole | null
    causedBy?: number | null
  }): Promise<void> {
    setEditError(null)
    try {
      await findingsStore.update(slug, finding!.id, patch)
    } catch (err) {
      setEditError((err as Error).message)
    }
  }

  async function remove(): Promise<void> {
    const ok = await confirm({ title: 'Delete finding?', message: finding!.summary, danger: true })
    if (ok) await findingsStore.remove(slug, finding!.id)
  }

  return (
    <ul data-testid="inline-finding" className="mr-6 list-none">
      <FindingCard
        finding={finding}
        slug={slug}
        open={open}
        selected={false}
        selectable={false}
        sessionId={sessionId}
        actingId={null}
        worktreeHead={null}
        repoNames={repoNames}
        onToggle={() => {
          if (finding.body) setOpen((o) => !o)
        }}
        onSelect={() => {}}
        onReview={(next) => void review(next)}
        onAction={() => {}}
        onCite={onCite}
        onDelete={() => void remove()}
        onWhy={() => setRejecting(true)}
        onEdit={(patch) => void edit(patch)}
        causeOptions={rows
          .filter((r) => r.mode === 'investigation')
          .map((r) => ({
            id: r.id,
            summary: r.summary,
            ...(isInactiveFinding(r) ? { inactive: true } : {})
          }))}
        note={
          item.name === 'mcp__argus__update_finding' && finding.reviewState === 'accepted'
            ? 'the agent changed this finding; your accept stands'
            : undefined
        }
        footer={
          editError || rejecting ? (
            <>
              {editError && (
                <p role="alert" className="px-3 pb-1 text-[10.5px] text-danger">
                  {editError}
                </p>
              )}
              {rejecting && (
                <FindingRejectStrip
                  onPick={(reason) => void review('rejected', reason)}
                  onSkip={() => setRejecting(false)}
                />
              )}
            </>
          ) : undefined
        }
      />
    </ul>
  )
}
