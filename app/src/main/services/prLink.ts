import type { DatabaseSync } from 'node:sqlite'
import { parsePrRef, remoteToOwnerRepo, type PrBinding, type PrRef } from '../../shared/pr'
import { assertSlug } from './caseFiles'
import { listStoredWorkspaces } from './workspaces'
import { addBinding, materializePrBindings, type PrMaterializer } from './prBindings'

export interface LinkPrForCaseDeps {
  db: DatabaseSync
  argusHome: string
  materialize: PrMaterializer
  /** Repo chips read worktree state and need telling that a PR was just (re)checked out. */
  broadcast: (caseSlug: string) => void
}

/**
 * The body of the `pr:link` IPC handler (main/index.ts), pulled out so the picker-vs-manual
 * parsing split is testable without booting Electron. Same DI-first posture as
 * reviewRunCompose.ts/reviewActionCompose.ts: `ipcMain.handle` is a thin wrapper that supplies
 * the live deps and calls this.
 *
 * Free text (the Repos rail's manual field) is parsed here; a picker selection already arrives
 * as a resolved `PrRef` — the shape is how the two sources are told apart. Both paths now share
 * the same side effect: materialize the worktree, then broadcast `workspacesChanged`. They used
 * to differ (only a picker selection did either) back when linking only ever ADDED a PR — the
 * `argus:prs` region of CLAUDE.md (materializePrBindings also writes it) just omitted whatever
 * a manual link hadn't materialized yet. Now that `addBinding` REPLACES the case's one binding,
 * skipping this on the manual path would leave that region naming the PR that is no longer
 * bound while the agent still reads it. The call is lazy and never fatal by design (a binding
 * with no local clone is skipped, a git failure is logged and stepped over — see
 * materializePrBindings), so unifying costs the manual path exactly the fetch the picker path
 * already pays.
 */
export async function linkPrForCase(
  deps: LinkPrForCaseDeps,
  caseSlug: string,
  input: string | PrRef
): Promise<PrBinding> {
  assertSlug(caseSlug)
  const stored = listStoredWorkspaces(deps.db, caseSlug) // throws `Unknown case` for a bad slug
  const manual = typeof input === 'string'
  const ref = manual ? parsePrRef(input, stored[0]?.remote ?? null) : input
  if (!ref) throw new Error(`Not a pull request reference: ${input}`)
  // Match the parsed owner/repo against the linked remotes so the binding knows which
  // local clone to make its worktree from. null stays supported (manual linking of a
  // PR in an unlinked repo) — the agent falls back to `gh pr diff`.
  const repoPath =
    stored.find((w) => {
      const or = w.remote ? remoteToOwnerRepo(w.remote) : null
      return or?.owner === ref.owner && or?.repo === ref.repo
    })?.path ?? null
  const binding = addBinding(deps.db, caseSlug, {
    ...ref,
    repoPath,
    source: manual ? 'manual' : 'search'
  })
  await materializePrBindings(deps.db, deps.argusHome, caseSlug, deps.materialize)
  deps.broadcast(caseSlug)
  return binding
}
