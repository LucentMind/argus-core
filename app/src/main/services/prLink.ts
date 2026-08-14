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

export interface LinkPrForCaseResult {
  binding: PrBinding
  /**
   * The checkout, still running. Resolves when the worktree (and the `argus:prs` region of
   * CLAUDE.md) is on disk; never rejects — `materializePrBindings` swallows and logs every
   * failure by design, and the `.catch` below covers anything it might ever stop swallowing.
   *
   * Callers that need the binding — every production caller — must NOT await this. It exists
   * so tests can observe the deferred work, and so the IPC handler can hang its second
   * broadcast off it.
   */
  materialized: Promise<void>
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
 *
 * That checkout is NOT awaited before returning. On a first link the worktree does not exist
 * yet, so `ensurePrWorktree` takes its slow path — `git fetch pull/N/head` (60s budget) then
 * `git worktree add`, a full working-tree write — which is unbounded in practice on a large
 * repo. `addBinding` has already committed by then and materialization is best-effort, so
 * nothing in the returned binding depends on it; awaiting only held the caller open. It held
 * the PR picker open specifically: `PrPickerDialog` closes on this resolving, and locks its
 * own Escape/✕/backdrop/buttons while it is in flight, so a cold fetch presented as a modal
 * the whole app sat behind with no progress shown and no way out.
 *
 * `broadcast` therefore fires TWICE, and both are load-bearing: once here, because the
 * binding is committed and the rail must stop showing the PR that is no longer bound, and
 * again when the checkout lands, because repo chips read worktree state that did not exist
 * at the first one. Both consumers treat it as "refetch what you own", so the repeat is a
 * cheap second refresh rather than a state change.
 */
export async function linkPrForCase(
  deps: LinkPrForCaseDeps,
  caseSlug: string,
  input: string | PrRef
): Promise<LinkPrForCaseResult> {
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
  deps.broadcast(caseSlug)
  const materialized = materializePrBindings(deps.db, deps.argusHome, caseSlug, deps.materialize)
    .catch((err) => {
      console.warn(`[pr] materialize after link for ${caseSlug} failed: ${(err as Error).message}`)
    })
    .then(() => {
      deps.broadcast(caseSlug)
    })
  return { binding, materialized }
}
