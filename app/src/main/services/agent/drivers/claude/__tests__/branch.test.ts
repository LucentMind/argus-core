import { describe, it, expect, vi, type Mock } from 'vitest'
import { createClaudeBranching, ANCHOR_NOT_IN_TRANSCRIPT, type ClaudeBranching } from '../branch'
import type { CreateQueryFn, QueryHandle } from '../index'

/** The SDK's control method, spelled out so each test's mock widens to the same type
 *  rather than to whatever its own literal happens to return. */
type RewindFn = NonNullable<QueryHandle['rewindFiles']>

/** What each test drives the branching module through: the injected createQuery plus the
 *  spies that record how the control query was configured and disposed of. */
interface FakeControlQuery {
  createQuery: CreateQueryFn
  calls: {
    options: Record<string, unknown>
    promptEndedBeforeClose: boolean | null
    // V10 (held open DURING the call, not just before close): whether the held-open
    // prompt had already been ended at the moment each rewindFiles call landed.
    rewindCalls: { dryRun: boolean; endedAtCall: boolean }[]
  }[]
  rewind: Mock<RewindFn>
  close: Mock<() => void>
}

const args = { cursor: 'sess-1', anchor: 'a-7', caseDir: 'C:/case', cliPath: 'C:/cli.js' }
/** The SDK transcript: turn 1 (u-1, a-6, a-7), turn 2 (u-2, a-8). The file anchor for
 *  "rewind to after a-7" is u-2 — the first user message AFTER the anchor. */
const transcript = [
  { type: 'user', uuid: 'u-1' },
  { type: 'assistant', uuid: 'a-6' },
  { type: 'assistant', uuid: 'a-7' },
  { type: 'user', uuid: 'u-2' },
  { type: 'assistant', uuid: 'a-8' }
]
const messages = vi.fn(async () => transcript)

function fakeControlQuery(
  rewind: Mock<RewindFn> = vi.fn<RewindFn>(async (_id, o) =>
    o?.dryRun
      ? { canRewind: true, filesChanged: ['note.txt'], insertions: 1, deletions: 1 }
      : { canRewind: true, skippedLinks: 1 }
  )
): FakeControlQuery {
  const calls: FakeControlQuery['calls'] = []
  const close = vi.fn<() => void>()
  const createQuery: CreateQueryFn = (a) => {
    const entry: FakeControlQuery['calls'][number] = {
      options: a.options,
      promptEndedBeforeClose: null,
      rewindCalls: []
    }
    let ended = false
    void (async () => {
      for await (const _ of a.prompt) void _
      ended = true
    })()
    close.mockImplementation(() => {
      entry.promptEndedBeforeClose = ended
    })
    calls.push(entry)
    // Records, per call, whether the held-open prompt had already ended BEFORE this
    // rewindFiles invocation landed — not just before close(), which V10's original
    // assertion covered. Catches a mutation that ends the prompt too early (e.g. before
    // the dry run) even though close() still runs after the prompt has ended either way.
    const rewindFiles: RewindFn = (async (id, o) => {
      entry.rewindCalls.push({ dryRun: Boolean(o?.dryRun), endedAtCall: ended })
      return rewind(id, o)
    }) as RewindFn
    return {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      async *[Symbol.asyncIterator]() {},
      interrupt: async () => undefined,
      rewindFiles,
      close
    }
  }
  return { createQuery, calls, rewind, close }
}
const make = (
  q: FakeControlQuery,
  fork = vi.fn(async () => ({ sessionId: 'fork-9' }))
): ClaudeBranching =>
  createClaudeBranching({ createQuery: q.createQuery, fork, messages, spawnEnv: () => ({}) })

describe('claude branching', () => {
  it('forkAt calls the SDK fork with the anchor and the session cwd and returns the new id', async () => {
    const fork = vi.fn(async () => ({ sessionId: 'fork-9' }))
    await expect(make(fakeControlQuery(), fork).forkAt(args)).resolves.toBe('fork-9')
    expect(fork).toHaveBeenCalledWith('sess-1', { upToMessageId: 'a-7', dir: 'C:/case' })
  })
  it('previewRewind resolves the file anchor from the transcript, dry-runs on a held-open resumed query, then ends the prompt and closes', async () => {
    const q = fakeControlQuery()
    const out = await make(q).previewRewind(args)
    expect(out).toEqual({ restored: ['note.txt'], skipped: 0 })
    expect(messages).toHaveBeenCalledWith('sess-1', { dir: 'C:/case' })
    expect(q.calls[0].options).toMatchObject({
      resume: 'sess-1',
      cwd: 'C:/case',
      enableFileCheckpointing: true,
      pathToClaudeCodeExecutable: 'C:/cli.js'
    })
    expect(q.rewind).toHaveBeenCalledWith('u-2', { dryRun: true })
    expect(q.close).toHaveBeenCalledTimes(1)
    // V10: the prompt is held open for the WHOLE exchange, not just closed after. The
    // dry-run call itself must see the prompt still open (endedAtCall: false) — a bug that
    // ends the prompt before the call would still leave promptEndedBeforeClose true below.
    expect(q.calls[0].rewindCalls).toEqual([{ dryRun: true, endedAtCall: false }])
    await new Promise((r) => setTimeout(r, 0))
    expect(q.calls[0].promptEndedBeforeClose).toBe(true) // V10: held open during the call, ended before close
  })
  it('omits pathToClaudeCodeExecutable from the control options when cliPath is absent', async () => {
    const q = fakeControlQuery()
    await make(q).previewRewind({ ...args, cliPath: undefined })
    expect(q.calls[0].options).not.toHaveProperty('pathToClaudeCodeExecutable')
  })
  it('passes spawnEnv() through to the control options as env', async () => {
    const q = fakeControlQuery()
    const fork = vi.fn(async () => ({ sessionId: 'fork-9' }))
    const branching = createClaudeBranching({
      createQuery: q.createQuery,
      fork,
      messages,
      spawnEnv: () => ({ FOO: 'bar' })
    })
    await branching.previewRewind(args)
    expect(q.calls[0].options.env).toEqual({ FOO: 'bar' })
  })
  it('rewindTo forks up to the anchor FIRST, then dry-runs and rewinds for real on the ORIGINAL session (one query)', async () => {
    const q = fakeControlQuery()
    const order: string[] = []
    q.rewind.mockImplementation(async (_id, o) => {
      order.push(o?.dryRun ? 'dry' : 'real')
      return o?.dryRun
        ? { canRewind: true, filesChanged: ['note.txt'] }
        : { canRewind: true, skippedLinks: 0 }
    })
    const fork = vi.fn(async () => {
      order.push('fork')
      return { sessionId: 'fork-2' }
    })
    await expect(make(q, fork).rewindTo(args)).resolves.toBe('fork-2')
    expect(q.rewind).toHaveBeenLastCalledWith('u-2', undefined)
    // Fork first: the fork is a pure transcript-store copy of the ORIGINAL session (both
    // the fork and the rewind target `a.cursor`/the original session, never each other), so
    // a stray fork left behind by a later rewind failure is harmless. The reverse order
    // would leave the user's working tree rewound with no branch to show for it if `fork`
    // then threw.
    expect(order).toEqual(['fork', 'dry', 'real'])
    expect(q.calls).toHaveLength(1)
    expect(q.close).toHaveBeenCalledTimes(1)
    // V10: both control calls must see the held-open prompt still open at call time.
    expect(q.calls[0].rewindCalls).toEqual([
      { dryRun: true, endedAtCall: false },
      { dryRun: false, endedAtCall: false }
    ])
  })
  it('rewindTo still forks (a harmless stray) but rejects when the SDK refuses the file rewind', async () => {
    const q = fakeControlQuery(
      vi.fn<RewindFn>(async () => ({ canRewind: false, error: 'no checkpoints' }))
    )
    const fork = vi.fn(async () => ({ sessionId: 'fork-2' }))
    await expect(make(q, fork).rewindTo(args)).rejects.toThrow(/no checkpoints/)
    // Fork-first means the fork already ran by the time the rewind is refused — a stray,
    // harmless transcript copy the user never sees a branch entry point promoted to, since
    // the method still rejects.
    expect(fork).toHaveBeenCalledWith('sess-1', { upToMessageId: 'a-7', dir: 'C:/case' })
    expect(q.close).toHaveBeenCalledTimes(1)
  })
  it('previewRewind reports an unavailable checkpoint as an error, not a throw', async () => {
    const q = fakeControlQuery(
      vi.fn<RewindFn>(async () => ({ canRewind: false, error: 'no checkpoints' }))
    )
    await expect(make(q).previewRewind(args)).resolves.toEqual({
      restored: [],
      skipped: 0,
      error: 'no checkpoints'
    })
  })
  it('previewRewind reports "no turn after the anchor" when the anchor is the last assistant message', async () => {
    const q = fakeControlQuery()
    await expect(make(q).previewRewind({ ...args, anchor: 'a-8' })).resolves.toEqual({
      restored: [],
      skipped: 0,
      error: 'no turn after the anchor'
    })
    expect(q.calls).toHaveLength(0) // no query is opened when there is nothing to rewind to
  })
  it('previewRewind reports a missing anchor distinctly from "no turn after the anchor"', async () => {
    const q = fakeControlQuery()
    await expect(make(q).previewRewind({ ...args, anchor: 'not-in-transcript' })).resolves.toEqual({
      restored: [],
      skipped: 0,
      error: ANCHOR_NOT_IN_TRANSCRIPT
    })
    expect(q.calls).toHaveLength(0) // no query is opened when the anchor can't be resolved
  })
})
