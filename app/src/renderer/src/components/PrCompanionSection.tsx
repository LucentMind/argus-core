import { GitPullRequest, RefreshCw, Stethoscope } from 'lucide-react'
import type { PrCheck, PrStatus } from '../../../shared/prStatus'
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
  if (mode !== 'review') return null
  const status = all[slug] ?? null

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>
        <span className="flex items-center gap-1.5">
          <GitPullRequest size={12} />
          Pull request
          {status && <PrRollupDot rollup={status.rollup} />}
          <span className="flex-1" />
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
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone={STATE_TONE[status.state]}>
              {status.isDraft ? 'draft · ' : ''}
              {status.state === 'UNKNOWN' ? 'state unknown' : status.state.toLowerCase()}
            </Chip>
            {(status.reviewDecision !== null || status.mergeable === 'CONFLICTING') && (
              <span className="text-[11px] text-mute">
                {[
                  status.reviewDecision ? DECISION_LABEL[status.reviewDecision] : null,
                  status.mergeable === 'CONFLICTING' ? 'conflicts' : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </div>

          {status.rollup === 'unavailable' && (
            <p className="text-[11px] text-danger">
              Could not read this pull request: {status.error}
            </p>
          )}

          {status.rollup !== 'unavailable' && status.checks.length === 0 && (
            <p className="text-[11px] text-mute">No checks reported.</p>
          )}

          {status.rollup !== 'unavailable' && status.checks.length > 0 && (
            <div className="divide-y divide-hair overflow-hidden rounded-r2 border border-hair bg-panel">
              {status.checks.map((c, i) => {
                const analyzable = c.bucket === 'fail' && c.jobId !== null
                return (
                  // Keyed on name AND index: check names are NOT unique on real pull requests
                  // (the Task 1 capture found one PR listing "Semantic Pull Request" twice and
                  // another with 46 contexts under 20 names), and a duplicate React key drops
                  // rows silently.
                  <div
                    key={`${c.name}#${i}`}
                    className="flex items-center gap-1.5 px-2 py-1.5 text-[11px]"
                  >
                    <span
                      aria-hidden="true"
                      className={
                        c.bucket === 'fail'
                          ? 'text-danger'
                          : c.bucket === 'pass'
                            ? 'text-signal'
                            : 'text-mute'
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
                        disabled={!analyzable}
                        onClick={() => onAnalyze(c.name)}
                      >
                        <Stethoscope size={12} />
                      </IconBtn>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
