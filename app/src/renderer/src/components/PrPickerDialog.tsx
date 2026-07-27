import { useState } from 'react'
import { Btn, Chip } from './ui'
import { ModalShell } from './ModalShell'
import type { PrCandidate, PrSearchResult } from '../../../shared/pr'

const keyOf = (c: PrCandidate): string => `${c.owner}/${c.repo}#${c.number}`

/** The candidate the dialog opens with selected: the first `preselected` hit, or — when
 *  every hit is a backport — the first candidate anyway, so the dialog is never
 *  confirmable-but-empty. */
function defaultKey(candidates: PrCandidate[]): string | null {
  const pre = candidates.find((c) => c.preselected)
  const first = pre ?? candidates[0]
  return first ? keyOf(first) : null
}

/**
 * Pick which of a case's candidate PRs to bind, modeled on JiraAttachmentsDialog.
 *
 * A case binds at most one PR, so this is a single choice: the non-backport heuristic
 * only ever picks the *default* radio (`candidate.preselected`), so a miss costs one
 * click and never hides or binds anything on its own. Both the error and empty states
 * stay dismissible — manual linking in the repos rail is always the fallback.
 */
export function PrPickerDialog({
  slug,
  result,
  onClose
}: {
  slug: string
  result: PrSearchResult
  onClose: () => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(() => defaultKey(result.candidates))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm(): Promise<void> {
    setBusy(true)
    setError(null)
    const candidate = result.candidates.find((c) => keyOf(c) === selected)
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
                {c.isBackport && <Chip tone="neutral">backport</Chip>}
                {c.isDraft && <Chip tone="neutral">draft</Chip>}
                <Chip tone={c.state === 'merged' ? 'signal' : 'neutral'}>{c.state}</Chip>
              </label>
            )
          })}
        </div>
        <div className="flex items-center gap-2">
          <Btn variant="primary" disabled={busy} onClick={() => void confirm()}>
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
