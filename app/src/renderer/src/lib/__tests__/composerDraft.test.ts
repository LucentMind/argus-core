import { it, expect } from 'vitest'
import { composerDraft } from '../composerDraft'

it('stages, replaces, and clears text per (case, session) and notifies', () => {
  composerDraft.clear('CASE-A', 1)
  let ticks = 0
  const off = composerDraft.subscribe(() => ticks++)

  expect(composerDraft.get('CASE-A', 1)).toBeUndefined()
  composerDraft.set('CASE-A', 1, 'look at line 5')
  composerDraft.set('CASE-A', 2, 'other session')
  expect(composerDraft.get('CASE-A', 1)).toBe('look at line 5')
  expect(composerDraft.get('CASE-A', 2)).toBe('other session')

  // set replaces (does not accumulate)
  composerDraft.set('CASE-A', 1, 'replaced')
  expect(composerDraft.get('CASE-A', 1)).toBe('replaced')

  composerDraft.clear('CASE-A', 1)
  expect(composerDraft.get('CASE-A', 1)).toBeUndefined()
  expect(composerDraft.get('CASE-A', 2)).toBe('other session')

  const before = ticks
  composerDraft.clear('CASE-A', 1) // already empty → no notify
  expect(ticks).toBe(before)
  expect(ticks).toBeGreaterThan(0)
  off()
})
