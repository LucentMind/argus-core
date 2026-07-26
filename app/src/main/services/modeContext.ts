import type { DatabaseSync } from 'node:sqlite'
import type { ModeContext } from '../../shared/modes'
import { listStoredWorkspaces } from './workspaces'

/**
 * Review mode needs a locally linked repo, not a bound PR: a PR is materialized as a
 * git worktree off an existing clone, and PR discovery happens *inside* review mode,
 * so a binding-count gate could never open. See
 * specs/2026-07-26-github-pr-detection-design.md.
 */
export function modeContextForCase(db: DatabaseSync, caseSlug: string): ModeContext {
  // Total by construction: listStoredWorkspaces throws on an unknown slug, but
  // availableModes is read on UI paths that must not fail if a case was just deleted.
  try {
    return { linkedRepoCount: listStoredWorkspaces(db, caseSlug).length }
  } catch {
    return { linkedRepoCount: 0 }
  }
}
