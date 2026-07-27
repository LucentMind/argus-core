import type { DatabaseSync } from 'node:sqlite'
import { parsePrRef, remoteToOwnerRepo, type PrBinding, type PrRef } from '../../shared/pr'
import { assertSlug } from './caseFiles'
import { listStoredWorkspaces } from './workspaces'
import { addBinding, materializePrBindings, type PrMaterializer } from './prBindings'

export interface LinkPrForCaseDeps {
  db: DatabaseSync
  argusHome: string
  materialize: PrMaterializer
  /** Fired only on a picker selection (see below) — repo chips read worktree state and need
   *  telling that a PR was just checked out. */
  broadcast: (caseSlug: string) => void
}

/**
 * The body of the `pr:link` IPC handler (main/index.ts), pulled out so the picker-vs-manual
 * side-effect gate — materialize the worktree, then broadcast `workspacesChanged` — is testable
 * without booting Electron. Same DI-first posture as reviewRunCompose.ts/reviewActionCompose.ts:
 * `ipcMain.handle` is a thin wrapper that supplies the live deps and calls this.
 *
 * Free text (the Repos rail's manual field) is parsed here; a picker selection already arrives
 * as a resolved `PrRef` — the shape is how the two sources are told apart. A picker selection,
 * like the old `pr:link-many`, checks out the PR's worktree right away and tells the repo chips.
 * Manual linking (the Repos rail) does neither — its caller reloads its own state after the call
 * resolves. This asymmetry is pre-existing and deliberate, not a bug to fix here.
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
  if (!manual) {
    await materializePrBindings(deps.db, deps.argusHome, caseSlug, deps.materialize)
    deps.broadcast(caseSlug)
  }
  return binding
}
