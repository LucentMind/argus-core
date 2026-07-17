// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchSnippet, invalidateCase, clearSnippetCache } from '../snippetCache'

const ok = {
  ok: true,
  evidenceId: 1,
  relPath: 'evidence/a.log',
  startLine: 1,
  lines: ['x'],
  lang: null,
  eof: false
}

function stubArgus(): {
  readSnippet: ReturnType<typeof vi.fn>
  onChanged: ReturnType<typeof vi.fn>
} {
  const readSnippet = vi.fn(async () => ok)
  const onChanged = vi.fn(() => () => undefined)
  window.argus = { evidence: { readSnippet, onChanged } } as never
  return { readSnippet, onChanged }
}

beforeEach(() => {
  clearSnippetCache()
})

describe('snippetCache', () => {
  it('dedupes concurrent and repeated fetches for the same citation', async () => {
    const { readSnippet } = stubArgus()
    const [a, b] = await Promise.all([
      fetchSnippet('C-1', 'evidence/a.log', 5),
      fetchSnippet('C-1', 'evidence/a.log', 5)
    ])
    await fetchSnippet('C-1', 'evidence/a.log', 5)
    expect(a).toEqual(ok)
    expect(b).toEqual(ok)
    expect(readSnippet).toHaveBeenCalledTimes(1)
  })

  it('different lines are different cache entries', async () => {
    const { readSnippet } = stubArgus()
    await fetchSnippet('C-1', 'evidence/a.log', 5)
    await fetchSnippet('C-1', 'evidence/a.log', 6)
    expect(readSnippet).toHaveBeenCalledTimes(2)
  })

  it('invalidateCase drops only that case, so it refetches', async () => {
    const { readSnippet } = stubArgus()
    await fetchSnippet('C-1', 'evidence/a.log', 5)
    await fetchSnippet('C-2', 'evidence/a.log', 5)
    invalidateCase('C-1')
    await fetchSnippet('C-1', 'evidence/a.log', 5)
    await fetchSnippet('C-2', 'evidence/a.log', 5)
    expect(readSnippet).toHaveBeenCalledTimes(3)
  })

  it('subscribes to evidence.onChanged once and invalidates the changed case', async () => {
    const { readSnippet, onChanged } = stubArgus()
    await fetchSnippet('C-1', 'evidence/a.log', 5)
    await fetchSnippet('C-1', 'evidence/b.log', 5)
    expect(onChanged).toHaveBeenCalledTimes(1)
    const cb = onChanged.mock.calls[0][0] as (slug: string) => void
    cb('C-1')
    await fetchSnippet('C-1', 'evidence/a.log', 5)
    expect(readSnippet).toHaveBeenCalledTimes(3)
  })

  it('maps an IPC rejection to a not-found result (and does not cache it)', async () => {
    const { readSnippet } = stubArgus()
    readSnippet.mockRejectedValueOnce(new Error('ipc broke'))
    expect(await fetchSnippet('C-1', 'evidence/a.log', 5)).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(await fetchSnippet('C-1', 'evidence/a.log', 5)).toEqual(ok)
  })
})
