import type { BranchArgs, RewindFilesPreview } from '../../driver'
import type { CreateQueryFn, QueryHandle } from './index'
import { AsyncQueue } from '../../asyncQueue'

export type ForkFn = (
  sessionId: string,
  opts: { upToMessageId: string; dir: string }
) => Promise<{ sessionId: string }>
/** The SDK's `getSessionMessages`: user/assistant messages in chronological order. */
export type MessagesFn = (
  sessionId: string,
  opts: { dir: string }
) => Promise<{ type: string; uuid: string }[]>

export interface ClaudeBranchDeps {
  createQuery: CreateQueryFn
  fork: ForkFn
  messages: MessagesFn
  /** `claudeSpawnEnv` — a real process env, so values are `string | undefined`. */
  spawnEnv: () => Record<string, string | undefined>
}

export const NO_TURN_AFTER_ANCHOR = 'no turn after the anchor'
export const ANCHOR_NOT_IN_TRANSCRIPT = 'anchor not found in the provider transcript'

/** The three `AgentDriver` branching methods, spread into the driver by `index.ts`. */
export interface ClaudeBranching {
  forkAt(a: BranchArgs): Promise<string>
  previewRewind(a: BranchArgs): Promise<RewindFilesPreview>
  rewindTo(a: BranchArgs): Promise<string>
}

/**
 * Session branching on the Claude driver (spec §6.3), shaped by what Task 1 recorded
 * (`__fixtures__/EVIDENCE.md`, "Branching"):
 *  - `forkSession` is a standalone SDK call over the CLI's transcript store; `dir` is the cwd
 *    the session ran under (the case dir, never the scratch cwd).
 *  - The stream never carries a user-message uuid, so the file-rewind anchor ("files as they
 *    were when the first discarded turn arrived") is resolved here from `getSessionMessages`:
 *    the first `user` message AFTER the anchor assistant uuid.
 *  - `rewindFiles` is a control method on a LIVE query. A query whose prompt iterable has
 *    already ended answers exactly ONE control request then dies, so the prompt is held open
 *    for the whole exchange and ended only after the last call, then `close()`.
 *  - Only the DRY RUN reports `filesChanged`; the real call returns `{canRewind, skippedLinks}`.
 *  - The fork and the file rewind are semantically independent of their relative order: both
 *    always target the ORIGINAL session (`a.cursor`), never each other, and the fork slices
 *    the transcript strictly up to `a.anchor` regardless of what happens to the working tree
 *    afterward. `rewindTo` still runs fork FIRST, chosen for its failure mode: the fork is a
 *    pure transcript-store copy, so a stray fork left behind by a later rewind failure is
 *    harmless, whereas rewinding first would leave the user's working tree mutated with no
 *    branch to show for it if `fork` then threw.
 */
export function createClaudeBranching(deps: ClaudeBranchDeps): ClaudeBranching {
  /** `anchorFound: false` means `a.anchor` doesn't exist in the transcript at all — distinct
   *  from `anchorFound: true, userMessageId: null`, where the anchor IS the last message and
   *  there is simply no later turn to rewind to. */
  async function fileAnchor(
    a: BranchArgs
  ): Promise<{ userMessageId: string | null; anchorFound: boolean }> {
    const msgs = await deps.messages(a.cursor, { dir: a.caseDir })
    const at = msgs.findIndex((m) => m.uuid === a.anchor)
    if (at < 0) return { userMessageId: null, anchorFound: false }
    return {
      userMessageId: msgs.slice(at + 1).find((m) => m.type === 'user')?.uuid ?? null,
      anchorFound: true
    }
  }

  /** A resumed, control-only query. `release()` ends the held-open prompt and closes it. */
  function controlQuery(a: BranchArgs): { q: QueryHandle; release: () => Promise<void> } {
    const held = new AsyncQueue<unknown>() // NOT ended: held open until release()
    const q = deps.createQuery({
      prompt: held,
      options: {
        cwd: a.caseDir,
        resume: a.cursor,
        enableFileCheckpointing: true,
        env: deps.spawnEnv(),
        ...(a.cliPath ? { pathToClaudeCodeExecutable: a.cliPath } : {})
      }
    })
    return {
      q,
      release: async () => {
        held.end()
        // Yield once so the SDK's prompt reader actually observes end-of-stream before the
        // query is torn down — `end()` only resolves the pending `next()`; the consumer
        // resumes on a later tick. Measured (Step 6, `__fixtures__/branch-dispose.jsonl`):
        // the CLI child exits either way, so this is ordering hygiene, not the reaper.
        await new Promise((r) => setTimeout(r, 0))
        try {
          q.close?.()
        } catch {
          // Swallow: a disposal error must never mask the rewind's own result/error.
        }
      }
    }
  }

  /** Dry-run, and when `real`, the real rewind too — on ONE control query. */
  async function rewindFiles(a: BranchArgs, real: boolean): Promise<RewindFilesPreview> {
    const { userMessageId, anchorFound } = await fileAnchor(a)
    if (!anchorFound) return { restored: [], skipped: 0, error: ANCHOR_NOT_IN_TRANSCRIPT }
    if (!userMessageId) return { restored: [], skipped: 0, error: NO_TURN_AFTER_ANCHOR }
    // Built INSIDE the try, nullable: if `controlQuery`'s own `createQuery` call throws,
    // `ctl` stays null and `finally` below simply skips release() — nothing half-built to
    // clean up, rather than leaking a query that never finished construction.
    let ctl: { q: QueryHandle; release: () => Promise<void> } | null = null
    try {
      ctl = controlQuery(a)
      const { q } = ctl
      if (typeof q.rewindFiles !== 'function') throw new Error('SDK query has no rewindFiles')
      const dry = await q.rewindFiles(userMessageId, { dryRun: true })
      if (!dry.canRewind) return { restored: [], skipped: 0, error: dry.error ?? 'cannot rewind' }
      const preview = { restored: dry.filesChanged ?? [], skipped: 0 }
      if (!real) return preview
      const done = await q.rewindFiles(userMessageId, undefined)
      if (!done.canRewind) return { ...preview, error: done.error ?? 'cannot rewind' }
      return { ...preview, skipped: done.skippedLinks ?? 0 }
    } finally {
      await ctl?.release()
    }
  }

  return {
    async forkAt(a: BranchArgs): Promise<string> {
      const { sessionId } = await deps.fork(a.cursor, { upToMessageId: a.anchor, dir: a.caseDir })
      return sessionId
    },
    async previewRewind(a: BranchArgs): Promise<RewindFilesPreview> {
      return rewindFiles(a, false)
    },
    async rewindTo(a: BranchArgs): Promise<string> {
      // Fork FIRST (see the doc comment above): a stray fork is harmless if the rewind
      // below then fails, whereas rewinding first risks a mutated working tree with no
      // branch if `fork` were to throw.
      const { sessionId } = await deps.fork(a.cursor, { upToMessageId: a.anchor, dir: a.caseDir })
      const r = await rewindFiles(a, true)
      if (r.error) throw new Error(`file rewind refused: ${r.error}`)
      return sessionId
    }
  }
}
