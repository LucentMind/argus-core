import { describe, it, expect } from 'vitest'
import { sortAttachmentsByType } from '../attachmentOrder'
import type { JiraAttachmentInfo } from '../../../../shared/jira'

const att = (filename: string, mimeType: string): JiraAttachmentInfo => ({
  id: filename,
  filename,
  size: 1,
  mimeType,
  createdAt: 'x'
})

describe('sortAttachmentsByType', () => {
  it('groups by mime type, then filename', () => {
    const out = sortAttachmentsByType([
      att('notes.md', 'text/plain'),
      att('deck.html', 'text/html'),
      att('trace.bin', 'application/octet-stream'),
      att('readme.md', 'text/plain')
    ])
    expect(out.map((a) => a.filename)).toEqual([
      'trace.bin', // application/*
      'deck.html', // text/html
      'notes.md', // text/plain, then alphabetical
      'readme.md'
    ])
  })

  it('sorts unknown types last instead of first', () => {
    const out = sortAttachmentsByType([att('mystery', ''), att('notes.md', 'text/plain')])
    expect(out.map((a) => a.filename)).toEqual(['notes.md', 'mystery'])
  })

  it('collates filenames case-insensitively and numerically', () => {
    const out = sortAttachmentsByType([
      att('log10.txt', 'text/plain'),
      att('Log2.txt', 'text/plain')
    ])
    expect(out.map((a) => a.filename)).toEqual(['Log2.txt', 'log10.txt'])
  })

  it('does not mutate its input', () => {
    const input = [att('b.md', 'text/plain'), att('a.html', 'text/html')]
    sortAttachmentsByType(input)
    expect(input.map((a) => a.filename)).toEqual(['b.md', 'a.html'])
  })
})
