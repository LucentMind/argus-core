// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fetchSnippet,
  invalidateCase,
  invalidateRepoSnippets,
  clearSnippetCache
} from '../snippetCache'

const ok = {
  ok: true,
  evidenceId: 1,
  relPath: 'evidence/a.log',
  startLine: 1,
  lines: ['x'],
  lang: null,
  eof: false
}

const repoOk = {
  ok: true,
  repoName: 'myrepo',
  relPath: 'src/a.ts',
  startLine: 1,
  lines: ['x'],
  lang: 'typescript',
  eof: false,
  truncated: false,
  ref: 'main'
}

function stubArgus(): {
  readSnippet: ReturnType<typeof vi.fn>
  onChanged: ReturnType<typeof vi.fn>
  wsReadSnippet: ReturnType<typeof vi.fn>
} {
  const readSnippet = vi.fn(async () => ok)
  const onChanged = vi.fn(() => () => undefined)
  const wsReadSnippet = vi.fn(async () => repoOk)
  window.argus = {
    evidence: { readSnippet, onChanged },
    workspaces: { readSnippet: wsReadSnippet }
  } as never
  return { readSnippet, onChanged, wsReadSnippet }
}

beforeEach(() => {
  clearSnippetCache()
})

describe('snippetCache', () => {
  it('dedupes concurrent and repeated fetches for the same citation', async () => {
    const { readSnippet } = stubArgus()
    const src = { kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/a.log' } as const
    const [a, b] = await Promise.all([fetchSnippet(src, 5, 5), fetchSnippet(src, 5, 5)])
    await fetchSnippet(src, 5, 5)
    expect(a).toEqual(ok)
    expect(b).toEqual(ok)
    expect(readSnippet).toHaveBeenCalledTimes(1)
  })

  it('different lines are different cache entries', async () => {
    const { readSnippet } = stubArgus()
    const src = { kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/a.log' } as const
    await fetchSnippet(src, 5, 5)
    await fetchSnippet(src, 6, 6)
    expect(readSnippet).toHaveBeenCalledTimes(2)
  })

  it('invalidateCase drops only that case, so it refetches', async () => {
    const { readSnippet } = stubArgus()
    const src1 = { kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/a.log' } as const
    const src2 = { kind: 'evidence', caseSlug: 'C-2', relPath: 'evidence/a.log' } as const
    await fetchSnippet(src1, 5, 5)
    await fetchSnippet(src2, 5, 5)
    invalidateCase('C-1')
    await fetchSnippet(src1, 5, 5)
    await fetchSnippet(src2, 5, 5)
    expect(readSnippet).toHaveBeenCalledTimes(3)
  })

  it('subscribes to evidence.onChanged once and invalidates the changed case', async () => {
    const { readSnippet, onChanged } = stubArgus()
    const srcA = { kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/a.log' } as const
    const srcB = { kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/b.log' } as const
    await fetchSnippet(srcA, 5, 5)
    await fetchSnippet(srcB, 5, 5)
    expect(onChanged).toHaveBeenCalledTimes(1)
    const cb = onChanged.mock.calls[0][0] as (slug: string) => void
    cb('C-1')
    await fetchSnippet(srcA, 5, 5)
    expect(readSnippet).toHaveBeenCalledTimes(3)
  })

  it('maps an IPC rejection to a not-found result (and does not cache it)', async () => {
    const { readSnippet } = stubArgus()
    const src = { kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/a.log' } as const
    readSnippet.mockRejectedValueOnce(new Error('ipc broke'))
    expect(await fetchSnippet(src, 5, 5)).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(await fetchSnippet(src, 5, 5)).toEqual(ok)
  })

  it('a rejected fetch does not evict a newer entry for the same key', async () => {
    const { readSnippet } = stubArgus()
    const src = { kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/a.log' } as const
    let rejectFirst: ((e: Error) => void) | undefined
    readSnippet.mockImplementationOnce(
      () =>
        new Promise((_, rej) => {
          rejectFirst = rej
        })
    )
    const first = fetchSnippet(src, 5, 5) // p1, pending
    invalidateCase('C-1') // key removed while p1 pending
    await fetchSnippet(src, 5, 5) // p2 cached, resolves ok
    rejectFirst!(new Error('boom'))
    expect(await first).toEqual({ ok: false, reason: 'not-found' })
    await fetchSnippet(src, 5, 5) // must hit p2's cache entry
    expect(readSnippet).toHaveBeenCalledTimes(2)
  })

  it('repo sources fetch via workspaces.readSnippet under a distinct key', async () => {
    const { readSnippet, wsReadSnippet } = stubArgus()
    const repoSrc = {
      kind: 'repo',
      caseSlug: 'C-1',
      repoName: 'myrepo',
      relPath: 'src/a.ts'
    } as const
    const evSrc = { kind: 'evidence', caseSlug: 'C-1', relPath: 'src/a.ts' } as const
    expect(await fetchSnippet(repoSrc, 1, 1)).toEqual(repoOk)
    await fetchSnippet(evSrc, 1, 1)
    expect(wsReadSnippet).toHaveBeenCalledWith('C-1', 'myrepo', 'src/a.ts', 1, 1)
    expect(readSnippet).toHaveBeenCalledTimes(1) // distinct keys, no cross-talk
  })

  it('invalidateRepoSnippets clears repo keys but not evidence keys', async () => {
    const { readSnippet, wsReadSnippet } = stubArgus()
    const repoSrc = {
      kind: 'repo',
      caseSlug: 'C-1',
      repoName: 'myrepo',
      relPath: 'src/a.ts'
    } as const
    const evSrc = { kind: 'evidence', caseSlug: 'C-1', relPath: 'evidence/a.log' } as const
    await fetchSnippet(repoSrc, 1, 1)
    await fetchSnippet(evSrc, 1, 1)
    invalidateRepoSnippets('C-1')
    await fetchSnippet(repoSrc, 1, 1)
    await fetchSnippet(evSrc, 1, 1)
    expect(wsReadSnippet).toHaveBeenCalledTimes(2)
    expect(readSnippet).toHaveBeenCalledTimes(1)
  })
})
