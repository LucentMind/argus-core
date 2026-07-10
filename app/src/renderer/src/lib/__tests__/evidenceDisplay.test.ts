import { describe, it, expect } from 'vitest'
import { displayName, formatMb } from '../evidenceDisplay'

describe('displayName', () => {
  it('strips the evidence/ prefix', () => {
    expect(displayName('evidence/log.txt')).toBe('log.txt')
  })

  it('strips evidence/.derived/ for derived files', () => {
    expect(displayName('evidence/.derived/trace.binlog.txt')).toBe('trace.binlog.txt')
  })

  it('leaves paths without the prefix untouched', () => {
    expect(displayName('other/log.txt')).toBe('other/log.txt')
  })

  it('keeps subdirectories below evidence/ visible', () => {
    expect(displayName('evidence/sub/log.txt')).toBe('sub/log.txt')
  })
})

describe('formatMb', () => {
  it('formats bytes as MB with one decimal', () => {
    expect(formatMb(13006439)).toBe('12.4 MB')
  })

  it('shows small files as <0.1 MB', () => {
    expect(formatMb(120)).toBe('<0.1 MB')
    expect(formatMb(0)).toBe('<0.1 MB')
  })

  it('shows exactly 0.1 MB at the boundary', () => {
    expect(formatMb(104858)).toBe('0.1 MB')
  })

  it('formats whole megabytes', () => {
    expect(formatMb(1048576)).toBe('1.0 MB')
  })
})
