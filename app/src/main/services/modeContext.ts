import type { DatabaseSync } from 'node:sqlite'
import { availableModes, DEFAULT_MODE, type ModeContext } from '../../shared/modes'
import { listStoredWorkspaces } from './workspaces'
import { getCase, setCaseMode } from './caseService'
import type { SessionProvider } from './agent/sessionStore'

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

/**
 * Send a case back to investigation if its active mode just stopped being available.
 *
 * Without this the user is stranded: `ModeSwitcher` takes its `modes.length <= 1` branch
 * and renders a static label with nothing to click, so a case left in `review` after its
 * last repo was unlinked has no way back.
 *
 * Called from the workspaces-unlink path, NOT from `pr:unlink` — removing a PR binding
 * does not change mode availability at all (see specs/2026-07-26-github-pr-detection-design.md).
 * Tested against `availableModes` rather than a hardcoded "review needs a repo" rule, so a
 * future third mode is covered without touching this.
 */
export async function demoteIfModeUnavailable(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  provider: SessionProvider
): Promise<void> {
  const active = getCase(db, caseSlug)?.activeMode
  if (!active) return
  if (availableModes(modeContextForCase(db, caseSlug)).includes(active)) return
  await setCaseMode(db, argusHome, caseSlug, DEFAULT_MODE, provider)
}
