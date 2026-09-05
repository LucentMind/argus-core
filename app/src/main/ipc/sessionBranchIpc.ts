import { IPC } from '../../shared/ipc'
import { assertSlug } from '../services/caseFiles'
import {
  rewindPreview,
  rewindSession,
  forkCaseSession,
  type BranchDeps
} from '../services/agent/sessionBranch'
import type { RewindPreview, RewindResult } from '../../shared/branching'
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
 * Registers the three session-branching request/response channels (preview/rewind/fork).
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
    const [caseSlug, sessionId, anchorTurnId] = args as [string, number, number]
    assertSlug(caseSlug)
    assertInt(sessionId)
    assertInt(anchorTurnId)
    return rewindSession(branchDeps(), caseSlug, sessionId, anchorTurnId)
  })
  handle(IPC.sessionsFork, (...args: unknown[]): Promise<SessionSummary> => {
    const [caseSlug, sessionId, anchorTurnId] = args as [string, number, number]
    assertSlug(caseSlug)
    assertInt(sessionId)
    assertInt(anchorTurnId)
    return forkCaseSession(branchDeps(), caseSlug, sessionId, anchorTurnId)
  })
}
