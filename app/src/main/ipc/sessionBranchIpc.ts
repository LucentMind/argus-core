import { IPC } from '../../shared/ipc'
import { assertSlug } from '../services/caseFiles'
import {
  branchPreview,
  rewindPreview,
  rewindSession,
  forkCaseSession,
  type BranchDeps
} from '../services/agent/sessionBranch'
import type { Branching, RewindPreview, RewindResult } from '../../shared/branching'
import type { SessionSummary } from '../../shared/types'

const assertInt = (n: number): void => {
  if (!Number.isInteger(n)) throw new Error(`Invalid id: ${n}`)
}

/**
 * `handle`/`branchDeps` are injected rather than importing `ipcMain` directly, so this is
 * testable under the house DI convention (see services/update/updateIpc.ts's identical shape).
 * `branchDeps` is a THUNK, not a resolved object — mirroring index.ts's own `branchDeps()` — so
 * a settings change (a re-pinned provider instance, say) between two calls is picked up fresh
 * rather than baked in at registration time.
 */
export interface SessionBranchIpcDeps {
  handle(channel: string, fn: (...args: unknown[]) => unknown): void
  branchDeps: () => BranchDeps
}

/**
 * Registers the four session-branching request/response channels (branch-preview, rewind-preview, rewind, fork).
 * `sessions:changed` is deliberately NOT registered here: it's a broadcast the `BranchDeps`
 * passed in fires itself (via its `sessionsChanged` callback) on the write paths' success, not
 * a channel a renderer ever invokes.
 */
export function registerSessionBranchIpc({ handle, branchDeps }: SessionBranchIpcDeps): void {
  handle(IPC.sessionsRewindPreview, (...args: unknown[]): Promise<RewindPreview> => {
    const [caseSlug, sessionId, anchorTurnId] = args as [string, number, number]
    assertSlug(caseSlug)
    assertInt(sessionId)
    assertInt(anchorTurnId)
    return rewindPreview(branchDeps(), caseSlug, sessionId, anchorTurnId)
  })
  handle(IPC.sessionsRewind, (...args: unknown[]): Promise<RewindResult> => {
    const [caseSlug, sessionId, anchorTurnId, opts] = args as [
      string,
      number,
      number,
      { filesUnavailable?: unknown } | undefined
    ]
    assertSlug(caseSlug)
    assertInt(sessionId)
    assertInt(anchorTurnId)
    // Coerced to a real boolean rather than passed through: this crosses the renderer boundary,
    // and `filesUnavailable` decides which driver call runs. Anything but literal `true` means
    // "restore the files", which is the behaviour a caller that has not thought about it gets.
    return rewindSession(branchDeps(), caseSlug, sessionId, anchorTurnId, {
      filesUnavailable: opts?.filesUnavailable === true
    })
  })
  handle(IPC.sessionsBranchPreview, (...args: unknown[]): Promise<{ branching: Branching }> => {
    const [caseSlug, sessionId, anchorTurnId] = args as [string, number, number]
    assertSlug(caseSlug)
    assertInt(sessionId)
    assertInt(anchorTurnId)
    return branchPreview(branchDeps(), caseSlug, sessionId, anchorTurnId)
  })
  handle(IPC.sessionsFork, (...args: unknown[]): Promise<SessionSummary> => {
    const [caseSlug, sessionId, anchorTurnId] = args as [string, number, number]
    assertSlug(caseSlug)
    assertInt(sessionId)
    assertInt(anchorTurnId)
    return forkCaseSession(branchDeps(), caseSlug, sessionId, anchorTurnId)
  })
}
