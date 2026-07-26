import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceInfo } from '../../../shared/types'
import type { BundleWorkspaceRef } from '../../../shared/bundle'
import type { PrBinding } from '../../../shared/pr'
import { FolderGit2, GitPullRequest, Unlink } from 'lucide-react'
import { Chip, IconBtn, SectionLabel } from './ui'
import { RepoGraphControl } from './RepoGraphControl'
import { reposStore } from '../lib/reposStore'
import { invalidateRepoSnippets } from '../lib/snippetCache'

/** Linked repos as evidence: the repo chips (moved here from the header), with
 *  link/unlink and the graph control. Individual files are not listed — code is
 *  cited per line via [repo/path:line] citations. */
export function ReposSection({
  slug,
  headerExtra
}: {
  slug: string
  /** rendered at the right edge of the Repos header (e.g. the pane-collapse button) */
  headerExtra?: React.ReactNode
}): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [refs, setRefs] = useState<BundleWorkspaceRef[]>([])
  const [prs, setPrs] = useState<PrBinding[]>([])
  const [prDraft, setPrDraft] = useState<string | null>(null)
  const [prError, setPrError] = useState<string | null>(null)

  const reload = useCallback((): Promise<void> => {
    // keep the citation domain + snippet cache in sync with link state
    invalidateRepoSnippets(slug)
    void reposStore.load(slug)
    void window.argus.pr.list(slug).then(setPrs)
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
    if (!value) return
    try {
      await window.argus.pr.link(slug, value)
      setPrDraft(null)
      setPrError(null)
      await reload()
    } catch {
      // main throws on anything parsePrRef can't read — say so instead of failing silently
      setPrError('Not a pull request reference.')
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
          {headerExtra}
        </div>
      </div>
      {workspaces.map((w) => (
        <div key={w.path} className="flex items-center gap-1">
          <Chip tone={w.worktreePath ? 'defect' : 'signal'}>
            {w.path.split(/[\\/]/).pop()} @ {w.currentRef}
            {w.dirty ? ' ●' : ''}
            {w.worktreePath ? ' · worktree' : ''}
          </Chip>
          <span className="flex-1" />
          <IconBtn
            aria-label="Unlink repo"
            title="Unlink repo"
            className="h-5 w-5 hover:text-danger"
            onClick={() => void window.argus.workspaces.unlink(slug, w.path).then(reload)}
          >
            <Unlink size={12} />
          </IconBtn>
          <RepoGraphControl repoPath={w.path} />
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
            onChange={(e) => setPrDraft(e.target.value)}
            placeholder="PR url, owner/repo#N, or number"
            className="w-full rounded border border-line bg-transparent px-1.5 py-0.5 text-xs"
          />
          {prError && <div className="mt-0.5 text-[11px] text-danger">{prError}</div>}
        </form>
      )}
      {/* Invisible until useful — same rule ModeSwitcher follows for a single mode. */}
      {prs.map((p) => (
        <div key={p.id} className="flex items-center gap-1">
          <Chip tone={p.repoPath ? 'defect' : 'neutral'} title={p.url}>
            {p.owner}/{p.repo}#{p.number}
            {p.repoPath ? '' : ' · no local clone'}
          </Chip>
          <span className="flex-1" />
          <IconBtn
            aria-label="Unlink PR"
            title="Unlink pull request"
            className="h-5 w-5 hover:text-danger"
            onClick={() => void window.argus.pr.unlink(slug, p.id).then(reload)}
          >
            <Unlink size={12} />
          </IconBtn>
        </div>
      ))}
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
