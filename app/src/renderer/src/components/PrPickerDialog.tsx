import { useEffect, useId, useState } from 'react'
import { Btn, Chip } from './ui'
import { ModalShell } from './ModalShell'
import type { PrBinding, PrCandidate, PrSearchResult } from '../../../shared/pr'
import { confirm as confirmDialog } from '../lib/confirmStore'
import { panelsStore } from '../lib/panelsStore'

const keyOf = (c: PrCandidate): string => `${c.owner}/${c.repo}#${c.number}`

/** Same `owner/repo#number` identity, case-insensitive. */
function sameIdentity(
  a: { owner: string; repo: string; number: number },
  b: { owner: string; repo: string; number: number }
): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.number === b.number
  )
}

/** The candidate the dialog opens with selected: the first `preselected` hit, or nothing when
 *  every hit is a backport. This is the one scenario the whole one-PR-per-case branch exists
 *  for (a PR and its backport turning up together) — defaulting to `candidates[0]` here would
 *  silently pre-select a backport. "Never confirmable-but-empty" is instead met by disabling
 *  Link/confirm while nothing is selected (see the `disabled` prop below), not by picking
 *  something. */
function defaultKey(candidates: PrCandidate[]): string | null {
  const pre = candidates.find((c) => c.preselected)
  return pre ? keyOf(pre) : null
}

/**
 * Pick which of a case's candidate PRs to bind, modeled on JiraAttachmentsDialog.
 *
 * A case binds at most one PR, so this is a single choice: the non-backport heuristic
 * only ever picks the *default* radio (`candidate.preselected`), so a miss costs one
 * click and never hides or binds anything on its own. Both the error and empty states
 * stay dismissible — manual linking in the repos rail is always the fallback.
 *
 * The picker is reachable ("Find PRs" in the Repos rail) whether or not a PR is already
 * bound — it is, in fact, the ONLY way to re-run the search once something is bound. So
 * `currentBinding`, when non-null, both marks that candidate in the list and gates
 * confirming a DIFFERENT one behind the same replace-warning ReposSection's manual link
 * uses: findings recorded against the current binding carry no PR reference of their own
 * and would otherwise silently retarget.
 */
export function PrPickerDialog({
  slug,
  result,
  currentBinding = null,
  onClose
}: {
  slug: string
  result: PrSearchResult
  /** The case's PR binding at the moment the picker opened, or null when nothing is
   *  bound. Optional so call sites that can never open the picker over an existing
   *  binding (none currently — kept for callers that don't track it) don't need to pass it. */
  currentBinding?: PrBinding | null
  onClose: () => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(() => defaultKey(result.candidates))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A docked panel is a native WebContentsView that paints above all DOM, so this modal must
  // register itself as an occlusion source (see panelsStore.registerModal) -- registering here
  // rather than at the call site means a future call site can't forget to occlude the panel.
  const modalId = useId()
  useEffect(() => panelsStore.registerModal(modalId), [modalId])

  async function confirm(): Promise<void> {
    if (busy) return // guards against a double-click racing the confirmDialog await below
    setError(null)
    const candidate = result.candidates.find((c) => keyOf(c) === selected)
    if (candidate && currentBinding && !sameIdentity(candidate, currentBinding)) {
      setBusy(true)
      const ok = await confirmDialog({
        title: `Replace ${currentBinding.owner}/${currentBinding.repo}#${currentBinding.number} with ${candidate.owner}/${candidate.repo}#${candidate.number}?`,
        message:
          'This case already has a pull request linked. Findings already recorded here will be attributed to the new pull request — any "comment" or "push" action on them will target it, not the one they were found against.',
        confirmLabel: 'Replace',
        danger: true
      })
      if (!ok) {
        setBusy(false)
        return
      }
    } else {
      setBusy(true)
    }
    try {
      if (candidate) {
        await window.argus.pr.link(slug, {
          owner: candidate.owner,
          repo: candidate.repo,
          number: candidate.number,
          url: candidate.url
        })
      }
      onClose()
    } catch {
      setBusy(false)
      setError('Could not link the selected pull request.')
    }
  }

  return (
    <ModalShell
      title="Link pull request"
      ariaLabel="Link pull request"
      onClose={busy ? () => {} : onClose}
      className="max-h-[85vh] w-[620px]"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {result.error && (
          <div
            role="alert"
            className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
          >
            {result.error} — you can still link a pull request by hand from the Repos rail.
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
          >
            {error}
          </div>
        )}
        {result.candidates.length === 0 && !result.error && (
          <div className="text-xs text-mute">
            No open or merged pull requests mention this ticket in{' '}
            {result.searchedRepos.join(', ') || 'any linked repo'}.
          </div>
        )}
        <div className="flex flex-col gap-1">
          {result.candidates.map((c) => {
            const k = keyOf(c)
            return (
              <label
                key={k}
                className="flex items-center gap-2 rounded-r1 px-1 py-0.5 text-xs hover:bg-hi"
              >
                <input
                  type="radio"
                  name="pr-picker-candidate"
                  // the number must be in the accessible name — it is how a row is identified
                  aria-label={`#${c.number} ${c.title}`}
                  checked={selected === k}
                  onChange={() => setSelected(k)}
                />
                <span className="shrink-0 font-mono text-mute">#{c.number}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{c.title}</span>
                {currentBinding && sameIdentity(c, currentBinding) && (
                  <Chip tone="defect">linked</Chip>
                )}
                {c.isBackport && <Chip tone="neutral">backport</Chip>}
                {c.isDraft && <Chip tone="neutral">draft</Chip>}
                <Chip tone={c.state === 'merged' ? 'signal' : 'neutral'}>{c.state}</Chip>
              </label>
            )
          })}
        </div>
        <div className="flex items-center gap-2">
          <Btn
            variant="primary"
            disabled={busy || selected === null}
            onClick={() => void confirm()}
          >
            Link selected
          </Btn>
          <Btn variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Btn>
        </div>
      </div>
    </ModalShell>
  )
}
