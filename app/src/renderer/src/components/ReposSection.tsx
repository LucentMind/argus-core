import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceInfo } from '../../../shared/types'
import type { BundleWorkspaceRef } from '../../../shared/bundle'
import type { PrSearchResult } from '../../../shared/pr'
import { parsePrRef } from '../../../shared/pr'
import { FolderGit2, GitPullRequest, Search, Unlink } from 'lucide-react'
import { Chip, IconBtn, SectionLabel } from './ui'
import { RepoGraphControl } from './RepoGraphControl'
import { reposStore } from '../lib/reposStore'
import { invalidateRepoSnippets } from '../lib/snippetCache'
import { confirm } from '../lib/confirmStore'
import { DEFAULT_MODE, type ModeId } from '../../../shared/modes'

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

/** Linked repos as evidence: the repo chips (moved here from the header), with
 *  link/unlink and the graph control. Individual files are not listed — code is
 *  cited per line via [repo/path:line] citations. */
export function ReposSection({
  slug,
  mode = DEFAULT_MODE,
  headerExtra,
  onPrsFound
}: {
  slug: string
  /** Review mode drops repo-management affordances (unlink, code graph): the repo under
   *  review is not the user's to manage from here. Defaults to investigation behavior. */
  mode?: ModeId
  /** rendered at the right edge of the Repos header (e.g. the pane-collapse button) */
  headerExtra?: React.ReactNode
  /** "Find PRs" result, handed up so the parent can open the picker over the chat. May
   *  return a promise (CaseWorkspace's handler does, so it can look up the case's current
   *  binding before opening the dialog) — `searching` below stays true until it settles, so
   *  a second search cannot start while the first result is still being turned into an open
   *  dialog. */
  onPrsFound?: (result: PrSearchResult) => void | Promise<void>
}): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [refs, setRefs] = useState<BundleWorkspaceRef[]>([])
  const [prDraft, setPrDraft] = useState<string | null>(null)
  const [prError, setPrError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  // `pr:link` now does real network work (a `git fetch` + `worktree add` under a repo lock,
  // since materialize+broadcast run unconditionally — see prLink.ts), not just a DB write —
  // without this the input stays enabled and shows nothing while it runs.
  const [linkingPr, setLinkingPr] = useState(false)

  const reload = useCallback((): Promise<void> => {
    // keep the citation domain + snippet cache in sync with link state
    invalidateRepoSnippets(slug)
    void reposStore.load(slug)
    return window.argus.workspaces.list(slug).then(setWorkspaces)
  }, [slug])

  useEffect(() => {
    void reload()
  }, [reload])
  useEffect(() => {
    void window.argus.workspaces.refs(slug).then(setRefs)
  }, [slug])
  // live refresh: the agent's workspace_checkout materializes a worktree without
  // any renderer action — the main process broadcasts so the chip updates in place
  useEffect(() => {
    if (!window.argus.workspaces.onChanged) return
    return window.argus.workspaces.onChanged((changed) => {
      if (changed === slug) void reload()
    })
  }, [slug, reload])

  async function link(): Promise<void> {
    const p = await window.argus.workspaces.pick()
    if (p) {
      await window.argus.workspaces.link(slug, p)
      await reload()
    }
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
    // A case has at most one bound PR (addBinding replaces, never adds); findings carry no PR
    // reference of their own — they resolve against whatever is bound NOW. Swapping the binding
    // out from under existing findings would silently retarget any "comment"/"push" action on
    // them to the new PR, so a replacement (as opposed to the first link, or re-linking the
    // SAME pr — addBinding is idempotent there and nothing retargets) is confirmed. Read fresh
    // rather than trusting `prs`: the Pull request section owns unlink now (Task 2) and does not
    // broadcast, so cached `prs` can name a PR that is no longer bound.
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
        await reload()
      } catch {
        // main throws on anything parsePrRef can't read — say so instead of failing silently.
        // (A CLAUDE.md write failure AFTER the binding committed no longer reaches here — see
        // materializePrBindings's own try/catch — so this message stays honest: it only fires
        // when the link genuinely never happened.)
        setPrError('Not a pull request reference.')
      }
    } finally {
      setLinkingPr(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <SectionLabel>Repos</SectionLabel>
        <div className="flex items-center gap-1">
          <IconBtn
            aria-label="Link repo"
            title="Link a local repo"
            className="h-5 w-5"
            onClick={() => void link()}
          >
            <FolderGit2 size={13} />
          </IconBtn>
          <IconBtn
            aria-label="Link PR"
            title="Link a pull request"
            className="h-5 w-5"
            onClick={() => setPrDraft((d) => (d === null ? '' : null))}
          >
            <GitPullRequest size={13} />
          </IconBtn>
          {onPrsFound && (
            <IconBtn
              aria-label="Find PRs"
              title="Search linked repos for this ticket's pull requests"
              className="h-5 w-5"
              disabled={searching}
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
          {headerExtra}
        </div>
      </div>
      {workspaces.map((w) => (
        <div key={w.path} className="flex items-center gap-1">
          <div className="min-w-0 flex-1 rounded-r2 border border-defect/30 bg-hair/50 px-2 py-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-xs font-medium text-defect">
                {w.path.split(/[\\/]/).pop()}
              </span>
              {w.dirty && (
                <span title="Uncommitted changes" className="shrink-0 text-[10px] text-signal">
                  ●
                </span>
              )}
              {w.worktreePath && (
                <span className="shrink-0 rounded-r1 border border-hair2 px-1 font-mono text-[9.5px] uppercase tracking-wide text-mute">
                  worktree
                </span>
              )}
            </div>
            <div
              title={w.currentRef}
              className="mt-0.5 truncate text-left font-mono text-[11px] text-mute"
              dir="rtl"
            >
              {/* dir=rtl truncates the START of the ref, keeping the topic segment that
                  carries the meaning — branch names here read <prefix>/<topic>. text-left
                  keeps the line pinned to the left at any length: direction picks which end
                  the ellipsis lands on, text-align is a separate axis and defaults to
                  following direction (right, for rtl) unless overridden. */}
              <span dir="ltr">{w.currentRef}</span>
            </div>
          </div>
          {mode !== 'review' && (
            <>
              <IconBtn
                aria-label="Unlink repo"
                title="Unlink repo"
                className="h-5 w-5 hover:text-danger"
                onClick={() => void window.argus.workspaces.unlink(slug, w.path).then(reload)}
              >
                <Unlink size={12} />
              </IconBtn>
              <RepoGraphControl repoPath={w.path} />
            </>
          )}
        </div>
      ))}
      {prDraft !== null && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void linkPr(prDraft)
          }}
        >
          <input
            autoFocus
            value={prDraft}
            disabled={linkingPr}
            onChange={(e) => setPrDraft(e.target.value)}
            placeholder={linkingPr ? 'Linking…' : 'PR url, owner/repo#N, or number'}
            className="w-full rounded border border-line bg-transparent px-1.5 py-0.5 text-xs disabled:opacity-60"
          />
          {prError && <div className="mt-0.5 text-[11px] text-danger">{prError}</div>}
        </form>
      )}
      {/* Bound PRs are not listed here: the Pull request section is their home, and naming
          them twice was the problem this rail had. Linking still lives here — `linkPr` queries
          the current binding fresh (rather than caching it) so a replacement link can be
          confirmed against the truth, not a copy that can go stale behind an unlink elsewhere. */}
      {refs.map((r, i) => (
        <Chip
          key={`${r.remote ?? 'ref'}-${i}`}
          tone="neutral"
          title={`${r.remote ?? 'unknown remote'} @ ${r.branch ?? '?'} ${r.commit ?? ''} — imported reference; link a local checkout to work with the code`}
        >
          {(r.remote ?? 'repo')
            .split('/')
            .pop()
            ?.replace(/\.git$/, '')}{' '}
          @ {r.commit?.slice(0, 7) ?? '?'} · unlinked
        </Chip>
      ))}
    </div>
  )
}
