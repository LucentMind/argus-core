import { useEffect, useState } from 'react'
import {
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  RefreshCw,
  Stethoscope,
  Unlink
} from 'lucide-react'
import type { CheckBucket, PrCheck, PrStatus } from '../../../shared/prStatus'
import type { PrBinding } from '../../../shared/pr'
import { prStatusStore, usePrStatuses } from '../lib/prStatusStore'
import { PrRollupDot } from './PrRollupDot'
import { Chip, IconBtn, SectionLabel } from './ui'

/** Review mode refreshes fast because the user is watching this exact PR. */
const REVIEW_POLL_MS = 20_000

const BUCKET_MARK: Record<PrCheck['bucket'], string> = {
  pass: '✓',
  fail: '✗',
  cancelled: '⊘',
  pending: '…',
  skipped: '–'
}

const DECISION_LABEL: Record<string, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REVIEW_REQUIRED: 'Review required'
}

const STATE_TONE: Record<PrStatus['state'], 'signal' | 'defect' | 'neutral'> = {
  OPEN: 'signal',
  CLOSED: 'defect',
  MERGED: 'neutral',
  UNKNOWN: 'neutral'
}

/**
 * Required first, optional second, GitHub's order preserved inside each group so a pull
 * request that repeats a check name keeps those runs adjacent.
 *
 * Headers appear only when something is required. On a repository with no branch protection
 * nothing is, and a lone "Not blocking merge" heading over the entire list would read as a
 * claim about policy rather than the absence of one.
 */
function groupChecks(checks: PrCheck[]): { label: string | null; items: PrCheck[] }[] {
  const required = checks.filter((c) => c.required)
  if (required.length === 0) return [{ label: null, items: checks }]
  return [
    { label: 'Required', items: required },
    { label: 'Not blocking merge', items: checks.filter((c) => !c.required) }
  ].filter((g) => g.items.length > 0)
}

/**
 * A single check row, shared verbatim by the open list and the folded-passed list so both
 * render identically.
 *
 * Defined at module scope (not nested inside `PrCompanionSection`) and takes `onAnalyze`
 * explicitly rather than closing over it: a component declared inside another component's body
 * is a fresh function reference on every parent render, so React remounts it — including its
 * `useState` in `CheckGroup` below — the moment anything upstream re-renders (here, the
 * `pr.list` binding effect resolving after the checks are already on screen). A remount mid
 * click swaps out the DOM node under the user's cursor before the click event reaches it,
 * silently dropping the Analyze handler.
 */
function CheckRow({
  c,
  onAnalyze
}: {
  c: PrCheck
  onAnalyze: (checkName: string) => void
}): React.JSX.Element {
  const analyzable = c.bucket === 'fail' && c.jobId !== null
  return (
    <div
      className={`flex h-7 items-center gap-1.5 rounded-r1 px-1.5 text-[11px] transition-colors hover:bg-hair/60 ${
        c.bucket === 'skipped' ? 'opacity-50' : ''
      }`}
    >
      <span
        aria-hidden="true"
        className={
          c.bucket === 'fail' ? 'text-danger' : c.bucket === 'pass' ? 'text-signal' : 'text-mute'
        }
      >
        {BUCKET_MARK[c.bucket]}
      </span>
      {c.url ? (
        <a
          href={c.url}
          target="_blank"
          rel="noreferrer"
          className="truncate text-ink hover:underline"
        >
          {c.name}
        </a>
      ) : (
        <span className="truncate text-ink">{c.name}</span>
      )}
      <span className="flex-1" />
      {c.bucket === 'fail' && (
        <IconBtn
          aria-label={`Analyze ${c.name} failure`}
          title={
            analyzable
              ? 'Pull this job log as evidence and analyze the failure'
              : 'Not a GitHub Actions job — Argus cannot read this check’s log'
          }
          className="h-5 w-5"
          disabled={!analyzable}
          onClick={() => onAnalyze(c.name)}
        >
          <Stethoscope size={12} />
        </IconBtn>
      )}
    </div>
  )
}

/**
 * One `groupChecks` bucket (Required / Not blocking merge / the unlabelled whole list). The
 * collapse state lives here, keyed by component instance rather than a shared flag, so opening
 * one group's passed rows never touches another's. Module-scoped for the same remount-safety
 * reason as `CheckRow` above.
 */
function CheckGroup({
  label,
  items,
  onAnalyze
}: {
  label: string | null
  items: PrCheck[]
  onAnalyze: (checkName: string) => void
}): React.JSX.Element {
  const [showPassed, setShowPassed] = useState(false)
  // Failures, cancellations, pending and skipped stay visible; only the green rows fold.
  const passed = items.filter((c) => c.bucket === 'pass')
  const rest = items.filter((c) => c.bucket !== 'pass')
  return (
    <div className="flex flex-col">
      {label && (
        <div
          role="heading"
          aria-level={3}
          className="px-1.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-mute"
        >
          {label}
        </div>
      )}
      {rest.map((c, i) => (
        <CheckRow key={`${c.name}#${i}`} c={c} onAnalyze={onAnalyze} />
      ))}
      {passed.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showPassed}
            aria-label={
              label
                ? `Show ${passed.length} passed checks in ${label}`
                : `Show ${passed.length} passed checks`
            }
            className="flex h-7 items-center gap-1.5 rounded-r1 px-1.5 text-[11px] text-mute transition-colors hover:bg-hair/60"
            onClick={() => setShowPassed((v) => !v)}
          >
            <ChevronRight
              size={11}
              className={`transition-transform ${showPassed ? 'rotate-90' : ''}`}
            />
            passed
            <span className="text-hair2">·</span>
            <span className="font-mono">{passed.length}</span>
          </button>
          {showPassed &&
            passed.map((c, i) => <CheckRow key={`${c.name}#${i}`} c={c} onAnalyze={onAnalyze} />)}
        </>
      )}
    </div>
  )
}

/**
 * Spec §7's PR/CI companion: the bound pull request's state and its checks, live while review
 * mode is open. Renders from `prStatusStore` (which mirrors the DB cache) and never fetches
 * directly — `usePrStatuses` owns the one refresh and the conditional poll.
 */
export function PrCompanionSection({
  slug,
  mode,
  onAnalyze
}: {
  slug: string
  mode: string
  onAnalyze: (checkName: string) => void
}): React.JSX.Element | null {
  // Hooks must run unconditionally, so the mode gate is applied to the RESULT, not the call.
  const all = usePrStatuses(mode === 'review' ? [slug] : [], REVIEW_POLL_MS)
  // ReposSection's "Link PR" control isn't mode-gated, so the bound PR can be replaced without
  // leaving review mode. Keying the binding effect on the bound PR's identity (not just slug and
  // mode) makes a mid-review relink refetch the binding instead of keeping the old one — an
  // unlink after that would otherwise target a binding id that no longer exists.
  const boundUrl = all[slug]?.url ?? null

  const [binding, setBinding] = useState<PrBinding | null>(null)
  useEffect(() => {
    if (mode !== 'review') return
    let live = true
    void window.argus.pr.list(slug).then((l) => {
      if (live) setBinding(l[0] ?? null)
    })
    return () => {
      live = false
    }
  }, [slug, mode, boundUrl])

  async function unlink(): Promise<void> {
    if (!binding) return
    await window.argus.pr.unlink(slug, binding.id)
    setBinding(null)
    prStatusStore.forget(slug)
  }

  if (mode !== 'review') return null
  const status = all[slug] ?? null

  const counts: Record<CheckBucket, number> = {
    pass: 0,
    fail: 0,
    cancelled: 0,
    pending: 0,
    skipped: 0
  }
  for (const c of status?.checks ?? []) counts[c.bucket]++

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>
        <span className="flex items-center gap-1.5">
          <GitPullRequest size={12} />
          Pull request
          {status && <PrRollupDot rollup={status.rollup} />}
          <span className="flex-1" />
          {binding && status && (
            <IconBtn
              aria-label="Unlink pull request"
              title="Unlink pull request"
              className="hover:text-danger"
              onClick={() => void unlink()}
            >
              <Unlink size={12} />
            </IconBtn>
          )}
          <IconBtn
            aria-label="Refresh pull request status"
            title="Refresh"
            onClick={() => void prStatusStore.refresh([slug])}
          >
            <RefreshCw size={12} />
          </IconBtn>
        </span>
      </SectionLabel>

      {!status && (
        <p className="text-[11px] text-mute">
          No pull request bound to this case yet — use Find PRs above.
        </p>
      )}

      {status && (
        <>
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              aria-label={`Open pull request ${status.owner}/${status.repo}#${status.number} on GitHub`}
              className="min-w-0 truncate font-mono text-xs text-ink transition-colors hover:text-defect hover:underline"
              onClick={() => void window.argus.openExternal(status.url)}
            >
              {status.owner}/{status.repo}#{status.number}
            </button>
            <Chip tone={STATE_TONE[status.state]}>
              {status.isDraft ? 'draft · ' : ''}
              {status.state === 'UNKNOWN' ? 'state unknown' : status.state.toLowerCase()}
            </Chip>
            {binding && binding.repoPath === null && (
              <span className="shrink-0 text-[11px] text-mute">no local clone</span>
            )}
            <span className="flex-1" />
            <IconBtn
              aria-label="Open pull request on GitHub"
              title="Open on GitHub"
              className="h-5 w-5"
              onClick={() => void window.argus.openExternal(status.url)}
            >
              <ExternalLink size={12} />
            </IconBtn>
          </div>

          {status.checks.length > 0 && (
            <p className="font-mono text-[10.5px] text-mute">
              {(
                [
                  counts.fail > 0 ? (
                    <span key="f" className="font-medium text-danger">
                      {counts.fail} failing
                    </span>
                  ) : null,
                  counts.cancelled > 0 ? <span key="c">{counts.cancelled} cancelled</span> : null,
                  counts.pending > 0 ? <span key="r">{counts.pending} running</span> : null,
                  counts.pass > 0 ? <span key="p">{counts.pass} passed</span> : null,
                  counts.skipped > 0 ? <span key="s">{counts.skipped} skipped</span> : null
                ].filter(Boolean) as React.JSX.Element[]
              ).map((el, i) => (
                <span key={el.key}>
                  {i > 0 && <span className="px-1 text-hair2">·</span>}
                  {el}
                </span>
              ))}
            </p>
          )}

          {/* The state tag now rides beside the PR identity above; only the qualifiers that
              do not fit a one-word tag stay down here. */}
          {(status.reviewDecision !== null ||
            status.mergeable === 'CONFLICTING' ||
            status.mergeStateStatus === 'BLOCKED') && (
            <p className="text-[11px] text-mute">
              {[
                status.reviewDecision ? DECISION_LABEL[status.reviewDecision] : null,
                status.mergeable === 'CONFLICTING' ? 'conflicts' : null,
                status.mergeStateStatus === 'BLOCKED' ? 'merge blocked' : null
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}

          {status.rollup === 'unavailable' && (
            <p className="text-[11px] text-danger">
              Could not read this pull request: {status.error}
            </p>
          )}

          {status.rollup !== 'unavailable' && status.checks.length === 0 && (
            <p className="text-[11px] text-mute">No checks reported.</p>
          )}

          {status.rollup !== 'unavailable' && status.checks.length > 0 && (
            <div className="flex flex-col">
              {groupChecks(status.checks).map((g) => (
                <CheckGroup
                  key={g.label ?? 'all'}
                  label={g.label}
                  items={g.items}
                  onAnalyze={onAnalyze}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
