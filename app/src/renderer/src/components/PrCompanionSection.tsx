import { useEffect, useState, useSyncExternalStore } from 'react'
import { ChevronRight, GitPullRequest, RefreshCw, Search, Stethoscope, Unlink } from 'lucide-react'
import type { CheckBucket, PrCheck, PrStatus } from '../../../shared/prStatus'
import type { PrBinding, PrSearchResult } from '../../../shared/pr'
import { parsePrRef } from '../../../shared/pr'
import { prStatusStore, usePrStatuses } from '../lib/prStatusStore'
import { confirm } from '../lib/confirmStore'
import { usePendingDisplay } from '../lib/usePendingDisplay'
import { uiStore } from '../lib/uiStore'
import { PrRollupDot } from './PrRollupDot'
import { BUCKET_TONE } from './prCheckTone'
import { Chip, IconBtn, MenuButton, SectionLabel, Skeleton } from './ui'

/** Review mode refreshes fast because the user is watching this exact PR. */
const REVIEW_POLL_MS = 20_000

/** Same `owner/repo#number` identity, case-insensitive — used to skip the replace-confirmation
 *  when the typed reference already names the currently bound PR. */
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
 * Defined at module scope (not nested inside `PrCompanionSection`) for remount safety: a
 * component declared inside another component's body is a fresh function reference on every
 * parent render, so React remounts it — including its `useState` in `CheckGroup` below — the
 * moment anything upstream re-renders (here, the `pr.list` binding effect resolving after the
 * checks are already on screen).
 *
 * It carries no Analyze control any more (user-directed, 2026-08-02). One stethoscope per
 * failing row put the same icon three or four times down a 300px rail, each one a per-row
 * decoration on the thing it was diagnosing; the single one beside the failing count says the
 * same thing once — see `AnalyzeControl`.
 */
function CheckRow({ c }: { c: PrCheck }): React.JSX.Element {
  return (
    <div
      className={`flex h-7 items-center gap-1.5 rounded-r1 px-1.5 text-[11px] transition-colors hover:bg-hair/60 ${
        c.bucket === 'skipped' ? 'opacity-50' : ''
      }`}
    >
      <span aria-hidden="true" className={BUCKET_TONE[c.bucket]}>
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
    </div>
  )
}

/**
 * The one Analyze control, beside the failing count.
 *
 * Only GitHub Actions jobs have a log Argus can pull (`jobId !== null`), so the shape depends on
 * how many of the failures qualify: none renders a disabled button that still explains why, one
 * analyzes directly, several open a menu naming each — the check name is a required argument of
 * `review:compose-ci-prompt`, so "analyze the failures" is not a thing that can be asked as one
 * call, and picking silently for the user would triage a job they did not choose.
 */
function AnalyzeControl({
  checks,
  onAnalyze
}: {
  checks: PrCheck[]
  onAnalyze: (checkName: string) => void
}): React.JSX.Element | null {
  const failing = checks.filter((c) => c.bucket === 'fail')
  if (failing.length === 0) return null
  const analyzable = failing.filter((c) => c.jobId !== null)
  if (analyzable.length === 0) {
    return (
      <IconBtn
        aria-label="Analyze failure"
        title="Not a GitHub Actions job — Argus cannot read this check’s log"
        size="xs"
        disabled
      >
        <Stethoscope size={12} />
      </IconBtn>
    )
  }
  if (analyzable.length === 1) {
    return (
      <IconBtn
        aria-label={`Analyze ${analyzable[0].name} failure`}
        title="Pull this job log as evidence and analyze the failure"
        size="xs"
        onClick={() => onAnalyze(analyzable[0].name)}
      >
        <Stethoscope size={12} />
      </IconBtn>
    )
  }
  return (
    <MenuButton
      aria-label="Analyze a failure"
      nocaret
      align="left"
      // `!` on every override: Btn's base string already carries h-7/px-3/border, and an appended
      // utility of equal specificity loses on stylesheet order alone (Tailwind emits h-5 before
      // h-7), so a plain `h-5` here would be silently inert. Same idiom CaseAnchor's trigger uses.
      triggerClassName="h-5! w-5! justify-center px-0! border-transparent! text-dim hover:bg-hair hover:text-ink"
      label={<Stethoscope size={12} />}
      items={analyzable.map((c) => ({ label: c.name, onSelect: () => onAnalyze(c.name) }))}
    />
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
  items
}: {
  label: string | null
  items: PrCheck[]
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
        <CheckRow key={`${c.name}#${i}`} c={c} />
      ))}
      {passed.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showPassed}
            aria-label={
              // "check" vs "checks": a lone passing check is common on a small PR, and the
              // accessible name is the only place the count is spoken.
              `Show ${passed.length} passed check${passed.length === 1 ? '' : 's'}${
                label ? ` in ${label}` : ''
              }`
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
          {showPassed && passed.map((c, i) => <CheckRow key={`${c.name}#${i}`} c={c} />)}
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
  onAnalyze,
  onPrsFound
}: {
  slug: string
  mode: string
  onAnalyze: (checkName: string) => void
  /** "Find PRs" result, handed up so the parent can open the picker over the chat. May
   *  return a promise (CaseWorkspace's handler does, so it can look up the case's current
   *  binding before opening the dialog) — `searching` below stays true until it settles, so
   *  a second search cannot start while the first result is still being turned into an open
   *  dialog. */
  onPrsFound?: (result: PrSearchResult) => void | Promise<void>
}): React.JSX.Element | null {
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const dynamic = ui.dynamicTheme
  // Hooks must run unconditionally, so the mode gate is applied to the RESULT, not the call.
  const all = usePrStatuses(mode === 'review' ? [slug] : [], REVIEW_POLL_MS)
  // "Link PR" isn't mode-gated internally, so the bound PR can be replaced without leaving
  // review mode. Keying the binding effect on the bound PR's identity (not just slug and mode)
  // makes a mid-review relink refetch the binding instead of keeping the old one — an unlink
  // after that would otherwise target a binding id that no longer exists.
  const boundUrl = all[slug]?.url ?? null

  // A boolean snapshot, so useSyncExternalStore's reference comparison is a value comparison.
  const statusLoaded = useSyncExternalStore(
    (cb) => prStatusStore.subscribe(cb),
    () => prStatusStore.isLoaded(slug)
  )
  const showStatusSkeleton = usePendingDisplay(mode === 'review' && !statusLoaded)

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

  const [prDraft, setPrDraft] = useState<string | null>(null)
  const [prError, setPrError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  // `pr:link` now does real network work (a `git fetch` + `worktree add` under a repo lock,
  // since materialize+broadcast run unconditionally — see prLink.ts), not just a DB write —
  // without this the box stays open and shows nothing while it runs.
  const [linkingPr, setLinkingPr] = useState(false)
  /** The manual Refresh's own round trip. Every other PR action already had a pending state;
   *  this one could be clicked repeatedly with nothing on screen to say it was working. */
  const [refreshingPr, setRefreshingPr] = useState(false)
  /** The reference being linked right now, shown as an optimistic row for the whole operation —
   *  `pr:link` AND the status refresh that follows. The user performed one action; two
   *  indicators with a gap between them is what made this section confusing. */
  const [linkingRef, setLinkingRef] = useState<string | null>(null)

  async function unlink(): Promise<void> {
    if (!binding) return
    await window.argus.pr.unlink(slug, binding.id)
    setBinding(null)
    prStatusStore.forget(slug)
  }

  async function linkPr(input: string): Promise<void> {
    const value = input.trim()
    if (!value || linkingPr) return
    // `linkingPr` gates BEFORE the fresh query and the confirm await, not just the IPC call
    // after it — same restructuring PrPickerDialog's `confirm()` got this round, for the same
    // reason: a double-click could otherwise race the awaits below and raise the confirm dialog
    // twice. It never bypasses the confirmation itself either way — confirmStore.request()
    // cancels (resolves `false`) a still-pending prompt when a newer one arrives — but a second
    // prompt flashing on screen is still worth closing.
    setLinkingPr(true)
    const parsedForDisplay = parsePrRef(value)
    setLinkingRef(
      parsedForDisplay
        ? `${parsedForDisplay.owner}/${parsedForDisplay.repo}#${parsedForDisplay.number}`
        : value
    )
    // A case has at most one bound PR (addBinding replaces, never adds); findings carry no PR
    // reference of their own — they resolve against whatever is bound NOW. Swapping the binding
    // out from under existing findings would silently retarget any "comment"/"push" action on
    // them to the new PR, so a replacement (as opposed to the first link, or re-linking the
    // SAME pr — addBinding is idempotent there and nothing retargets) is confirmed. Read fresh
    // rather than trusting `binding`: it is refetched only on slug/mode/boundUrl changes, so it
    // can lag an unlink or relink that happened elsewhere.
    // One outer finally covers every exit from here on, including a rejected pr.list: without it
    // a failed lookup would leave the input stuck disabled on "Linking…" until remount.
    try {
      const current = (await window.argus.pr.list(slug))[0]
      if (current) {
        const parsed = parsePrRef(value)
        const sameAsCurrent = parsed !== null && sameIdentity(parsed, current)
        if (!sameAsCurrent) {
          const ok = await confirm({
            title: `Replace ${current.owner}/${current.repo}#${current.number} with ${value}?`,
            message:
              'This case already has a pull request linked. Findings already recorded here will be attributed to the new pull request — any "comment" or "push" action on them will target it, not the one they were found against.',
            confirmLabel: 'Replace',
            danger: true
          })
          if (!ok) return
        }
      }
      try {
        await window.argus.pr.link(slug, value)
        setPrDraft(null)
        setPrError(null)
        // Refresh what this section owns: the binding (for unlink) and the status (so the
        // newly linked PR's subject line/checks appear without a manual refresh click).
        // prStatusStore.refresh hits GitHub — same call the header's own Refresh button makes.
        const list = await window.argus.pr.list(slug)
        setBinding(list[0] ?? null)
        // Awaited, not fire-and-forget: the pending row must stay up until the status that
        // replaces it is actually on screen.
        await prStatusStore
          .refresh([slug])
          .catch((err) =>
            console.warn(`[pr] status refresh failed for ${slug}: ${(err as Error).message}`)
          )
      } catch {
        // main throws on anything parsePrRef can't read — say so instead of failing silently.
        // (A CLAUDE.md write failure AFTER the binding committed no longer reaches here — see
        // materializePrBindings's own try/catch — so this message stays honest: it only fires
        // when the link genuinely never happened.)
        setPrError('Not a pull request reference.')
      }
    } finally {
      setLinkingPr(false)
      setLinkingRef(null)
    }
  }

  function refreshStatus(): void {
    setRefreshingPr(true)
    void prStatusStore
      .refresh([slug])
      .catch((err) =>
        console.warn(`[pr] status refresh failed for ${slug}: ${(err as Error).message}`)
      )
      .finally(() => setRefreshingPr(false))
  }

  if (mode !== 'review') return null
  const status = all[slug] ?? null
  /** One pending state for the whole section: while any PR round trip is in flight the header's
   *  actions grey out together, rather than each control policing only its own. */
  const busy = linkingPr || searching || refreshingPr

  const counts: Record<CheckBucket, number> = {
    pass: 0,
    fail: 0,
    cancelled: 0,
    pending: 0,
    skipped: 0
  }
  for (const c of status?.checks ?? []) counts[c.bucket]++

  return (
    <div
      // Both themes get a pane — see the note on ReposSection's own container.
      // Tight py-2/gap-1.5 rather than p-2.5/gap-2 (user-directed, 2026-08-04, matching
      // JiraSection/ReposSection/CaseFiles): the rail's section headers were eating more
      // vertical space than their content needed, across every card, not just one.
      className={`flex flex-col gap-1.5 rounded-r3 px-2.5 py-2 ${dynamic ? 'glass-panel' : 'surface-card'}`}
      data-tier={status?.rollup === 'failing' ? 'p1' : undefined}
    >
      <SectionLabel>
        <span className="flex items-center gap-1.5">
          <GitPullRequest size={12} />
          Pull request
          {status && <PrRollupDot rollup={status.rollup} />}
          <span className="flex-1" />
          <IconBtn
            aria-label="Link PR"
            title="Link a pull request"
            size="xs"
            disabled={busy}
            onClick={() => setPrDraft((d) => (d === null ? '' : null))}
          >
            <GitPullRequest size={13} />
          </IconBtn>
          {onPrsFound && (
            <IconBtn
              aria-label="Find PRs"
              title="Search linked repos for this ticket's pull requests"
              size="xs"
              disabled={busy}
              onClick={() => {
                setSearching(true)
                void window.argus.pr
                  .search(slug)
                  .then(onPrsFound)
                  .finally(() => setSearching(false))
              }}
            >
              <Search size={13} />
            </IconBtn>
          )}
          {/* Unlink is not here any more (user-directed, 2026-08-02): it acts on one specific
              pull request, so it belongs on that pull request's row — which is also where the
              Open-on-GitHub button used to sit doing nothing the PR title does not already do. */}
          <IconBtn
            aria-label="Refresh pull request status"
            title="Refresh"
            disabled={busy}
            onClick={refreshStatus}
          >
            <RefreshCw size={12} />
          </IconBtn>
        </span>
      </SectionLabel>

      {/* Closed for the duration of a link, rather than left open and disabled: the pending row
          below already restates the reference being linked, and the greyed box beside it read as
          a second, broken copy of the same thing. It reopens with the typed value still in it if
          the link fails, so `prError` lands under the field the user has to correct. */}
      {prDraft !== null && !linkingPr && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void linkPr(prDraft)
          }}
        >
          <input
            autoFocus
            value={prDraft}
            onChange={(e) => setPrDraft(e.target.value)}
            placeholder="PR url, owner/repo#N, or number"
            className="w-full rounded border border-hair bg-transparent px-1.5 py-0.5 text-xs"
          />
          {prError && <div className="mt-0.5 text-[11px] text-danger">{prError}</div>}
        </form>
      )}

      {/* Not gated on `!status` any more. Replacing an already-bound PR kept the old subject line
          on screen and put the only pending indicator in the box — so closing the box would have
          left a replacement with no indicator at all. The row also states the truth better: the
          PR shown above is no longer the one being bound. */}
      {linkingRef && (
        <div className="flex flex-col gap-1.5">
          <span className="truncate font-mono text-xs text-ink">{linkingRef}</span>
          <Skeleton className="h-2 w-[40%]" />
        </div>
      )}

      {!status && !linkingRef && showStatusSkeleton && (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-[55%]" />
          <Skeleton className="h-2 w-[40%]" />
        </div>
      )}

      {!status && !linkingRef && !showStatusSkeleton && statusLoaded && (
        <p className="text-[11px] text-mute">
          No pull request bound to this case yet — use Find PRs above.
        </p>
      )}

      {status && !linkingRef && (
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
            {/* The title above is already the open-on-GitHub control, so this slot carries the
                action that had nowhere else to be. */}
            {binding && (
              <IconBtn
                aria-label="Unlink pull request"
                title="Unlink pull request"
                size="xs"
                className="hover:text-danger"
                disabled={busy}
                onClick={() => void unlink()}
              >
                <Unlink size={12} />
              </IconBtn>
            )}
          </div>

          {status.checks.length > 0 && (
            <div className="flex h-5 items-center gap-1.5">
              <p className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mute">
                {(
                  [
                    counts.fail > 0 ? (
                      <span key="f" className="font-medium text-danger">
                        {counts.fail} failing
                      </span>
                    ) : null,
                    counts.cancelled > 0 ? <span key="c">{counts.cancelled} cancelled</span> : null,
                    counts.pending > 0 ? <span key="r">{counts.pending} running</span> : null,
                    // Green and grey, matching the marks these counts summarise (BUCKET_TONE):
                    // the failing count was the only one wearing its bucket's colour, so the
                    // line read as one signal plus a tail of undifferentiated text.
                    counts.pass > 0 ? (
                      <span key="p" className={BUCKET_TONE.pass}>
                        {counts.pass} passed
                      </span>
                    ) : null,
                    counts.skipped > 0 ? (
                      <span key="s" className={BUCKET_TONE.skipped}>
                        {counts.skipped} skipped
                      </span>
                    ) : null
                  ].filter(Boolean) as React.JSX.Element[]
                ).map((el, i) => (
                  <span key={el.key}>
                    {i > 0 && <span className="px-1 text-hair2">·</span>}
                    {el}
                  </span>
                ))}
              </p>
              <AnalyzeControl checks={status.checks} onAnalyze={onAnalyze} />
            </div>
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
                <CheckGroup key={g.label ?? 'all'} label={g.label} items={g.items} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
