import { describe, it, expect, beforeEach, vi } from 'vitest'
import { composerAttachments, type Attachment } from '../composerAttachments'

const att = (id: string, over: Partial<Attachment> = {}): Attachment => ({
  id,
  name: `${id}.png`,
  status: 'pending',
  ...over
})

beforeEach(() => {
  composerAttachments.clear('A-1', 1)
  composerAttachments.clear('A-1', 2)
  composerAttachments.clear('B-2', 1)
})

describe('composerAttachments', () => {
  it('returns a referentially stable empty array for an untouched key', () => {
    expect(composerAttachments.get('A-1', 9)).toBe(composerAttachments.get('A-1', 9))
  })

  it('keeps sessions and cases isolated', () => {
    composerAttachments.add('A-1', 1, att('x'))
    expect(composerAttachments.get('A-1', 1)).toHaveLength(1)
    expect(composerAttachments.get('A-1', 2)).toHaveLength(0)
    expect(composerAttachments.get('B-2', 1)).toHaveLength(0)
  })

  it('patches an attachment in place by id', () => {
    composerAttachments.add('A-1', 1, att('x'))
    composerAttachments.update('A-1', 1, 'x', { status: 'ready', relPath: 'evidence/x.png' })
    const [a] = composerAttachments.get('A-1', 1)
    expect(a.status).toBe('ready')
    expect(a.relPath).toBe('evidence/x.png')
    expect(a.name).toBe('x.png')
  })

  it('ignores an update for an unknown id', () => {
    composerAttachments.add('A-1', 1, att('x'))
    const cb = vi.fn()
    const off = composerAttachments.subscribe(cb)
    composerAttachments.update('A-1', 1, 'ghost', { status: 'ready' })
    expect(composerAttachments.get('A-1', 1)[0].status).toBe('pending')
    expect(cb).not.toHaveBeenCalled()
    off()
  })

  it('removes by id, not by position', () => {
    composerAttachments.add('A-1', 1, att('x'))
    composerAttachments.add('A-1', 1, att('y'))
    composerAttachments.remove('A-1', 1, 'x')
    expect(composerAttachments.get('A-1', 1).map((a) => a.id)).toEqual(['y'])
  })

  it('does not notify when removing an unknown id', () => {
    composerAttachments.add('A-1', 1, att('x'))
    const cb = vi.fn()
    const off = composerAttachments.subscribe(cb)
    composerAttachments.remove('A-1', 1, 'ghost')
    expect(composerAttachments.get('A-1', 1)).toHaveLength(1)
    expect(cb).not.toHaveBeenCalled()
    off()
  })

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const cb = vi.fn()
    const off = composerAttachments.subscribe(cb)
    composerAttachments.add('A-1', 1, att('x'))
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    composerAttachments.add('A-1', 1, att('y'))
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('does not notify when clearing an already-empty key', () => {
    const cb = vi.fn()
    const off = composerAttachments.subscribe(cb)
    composerAttachments.clear('A-1', 7)
    expect(cb).not.toHaveBeenCalled()
    off()
  })
})
