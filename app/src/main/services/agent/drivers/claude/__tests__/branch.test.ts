import { describe, it, expect, vi, type Mock } from 'vitest'
import { createClaudeBranching, type ClaudeBranching } from '../branch'
import type { CreateQueryFn, QueryHandle } from '../index'

/** The SDK's control method, spelled out so each test's mock widens to the same type
 *  rather than to whatever its own literal happens to return. */
type RewindFn = NonNullable<QueryHandle['rewindFiles']>

/** What each test drives the branching module through: the injected createQuery plus the
 *  spies that record how the control query was configured and disposed of. */
interface FakeControlQuery {
  createQuery: CreateQueryFn
  calls: { options: Record<string, unknown>; promptEndedBeforeClose: boolean | null }[]
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
  const calls: { options: Record<string, unknown>; promptEndedBeforeClose: boolean | null }[] = []
  const close = vi.fn<() => void>()
  const createQuery: CreateQueryFn = (a) => {
    const entry = { options: a.options, promptEndedBeforeClose: null as boolean | null }
    let ended = false
    void (async () => {
      for await (const _ of a.prompt) void _
      ended = true
    })()
    close.mockImplementation(() => {
      entry.promptEndedBeforeClose = ended
    })
    calls.push(entry)
    return {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      async *[Symbol.asyncIterator]() {},
      interrupt: async () => undefined,
      rewindFiles: rewind,
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
    await new Promise((r) => setTimeout(r, 0))
    expect(q.calls[0].promptEndedBeforeClose).toBe(true) // V10: held open during the call, ended before close
  })
  it('rewindTo dry-runs then rewinds for real on the ORIGINAL session (one query), then forks up to the anchor', async () => {
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
    expect(order).toEqual(['dry', 'real', 'fork'])
    expect(q.calls).toHaveLength(1)
    expect(q.close).toHaveBeenCalledTimes(1)
  })
  it('rewindTo throws (and does not fork) when the SDK refuses the file rewind', async () => {
    const q = fakeControlQuery(
      vi.fn<RewindFn>(async () => ({ canRewind: false, error: 'no checkpoints' }))
    )
    const fork = vi.fn()
    await expect(make(q, fork).rewindTo(args)).rejects.toThrow(/no checkpoints/)
    expect(fork).not.toHaveBeenCalled()
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
})
