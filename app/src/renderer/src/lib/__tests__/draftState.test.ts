import { describe, it, expect } from 'vitest'
import {
  bannerOnOpen,
  onExternalChange,
  isConflict,
  resolveConflict,
  type DiskSnapshot
} from '../draftState'
import type { DraftRecord } from '../../../../shared/editorIpc'

const DISK: DiskSnapshot = { content: 'on disk\n', hash: 'h1' }

const draft = (over: Partial<DraftRecord> = {}): DraftRecord => ({
  kind: 'skill',
  name: 'my-skill',
  mode: 'edit',
  content: 'mine\n',
  baseHash: 'h1',
  updatedAt: '2026-07-30T15:42:00.000Z',
  ...over
})

describe('bannerOnOpen', () => {
  it('shows nothing when there is no draft', () => {
    expect(bannerOnOpen(null, DISK)).toEqual({ kind: 'none' })
  })

  it('reports a restore when the draft was taken from what is on disk now', () => {
    expect(bannerOnOpen(draft(), DISK)).toEqual({
      kind: 'restored',
      updatedAt: '2026-07-30T15:42:00.000Z'
    })
  })

  it('reports staleness when the file moved under the draft', () => {
    expect(bannerOnOpen(draft({ baseHash: 'older' }), DISK)).toEqual({ kind: 'stale', disk: DISK })
  })

  it('restores a create-mode draft, which has no disk to be stale against', () => {
    expect(bannerOnOpen(draft({ mode: 'create', baseHash: null }), null)).toEqual({
      kind: 'restored',
      updatedAt: '2026-07-30T15:42:00.000Z'
    })
  })

  it('restores an orphaned draft whose asset was deleted from disk', () => {
    // Spec §4.5: orphans are kept, not discarded, and they still open.
    expect(bannerOnOpen(draft(), null).kind).toBe('restored')
  })
})

describe('onExternalChange', () => {
  it('does nothing when the file has not moved', () => {
    expect(onExternalChange({ dirty: true, baseHash: 'h1', disk: DISK })).toEqual({
      banner: { kind: 'none' },
      reload: false
    })
  })

  it('silently adopts disk when the buffer is clean', () => {
    expect(onExternalChange({ dirty: false, baseHash: 'older', disk: DISK })).toEqual({
      banner: { kind: 'none' },
      reload: true
    })
  })

  it('raises the staleness banner when the buffer is dirty', () => {
    expect(onExternalChange({ dirty: true, baseHash: 'older', disk: DISK })).toEqual({
      banner: { kind: 'stale', disk: DISK },
      reload: false
    })
  })

  it('does nothing in create mode, where there is no base to compare against', () => {
    expect(onExternalChange({ dirty: true, baseHash: null, disk: DISK })).toEqual({
      banner: { kind: 'none' },
      reload: false
    })
  })
})

describe('isConflict', () => {
  it('is true when disk moved past the hash the save was measured against', () => {
    expect(isConflict('older', DISK)).toBe(true)
  })

  it('is false when disk still matches — the save failed for some other reason', () => {
    expect(isConflict('h1', DISK)).toBe(false)
  })

  it('is false in create mode, where a rejected save is a name collision', () => {
    expect(isConflict(null, DISK)).toBe(false)
  })

  it('is false when the file could not be read at all', () => {
    expect(isConflict('older', null)).toBe(false)
  })
})

describe('resolveConflict', () => {
  it('Keep mine keeps the buffer but adopts the disk hash, so the next save wins', () => {
    expect(resolveConflict('keep-mine', { buffer: 'mine\n', disk: DISK })).toEqual({
      content: 'mine\n',
      baseHash: 'h1',
      discardDraft: false
    })
  })

  it('Use disk takes the disk text and throws the draft away', () => {
    expect(resolveConflict('use-disk', { buffer: 'mine\n', disk: DISK })).toEqual({
      content: 'on disk\n',
      baseHash: 'h1',
      discardDraft: true
    })
  })
})
