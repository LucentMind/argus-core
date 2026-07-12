import { describe, it, expect } from 'vitest'
import { stripQuarantine } from '../quarantine'

describe('stripQuarantine', () => {
  it('runs xattr -dr on darwin with the bundle dir', () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    stripQuarantine('/tmp/bundle', {
      platform: 'darwin',
      run: (cmd, args) => calls.push({ cmd, args })
    })
    expect(calls).toEqual([{ cmd: 'xattr', args: ['-dr', 'com.apple.quarantine', '/tmp/bundle'] }])
  })

  it('is a no-op on non-darwin platforms', () => {
    const calls: string[] = []
    stripQuarantine('/tmp/bundle', { platform: 'win32', run: (cmd) => calls.push(cmd) })
    expect(calls).toEqual([])
  })

  it('swallows a failure from the underlying command (best-effort)', () => {
    expect(() =>
      stripQuarantine('/tmp/bundle', {
        platform: 'darwin',
        run: () => {
          throw new Error('xattr missing')
        }
      })
    ).not.toThrow()
  })
})
