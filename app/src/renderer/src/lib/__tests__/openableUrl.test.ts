import { describe, it, expect } from 'vitest'
import { isOpenableUrl } from '../openableUrl'

describe('isOpenableUrl', () => {
  it('allows http and https in any case', () => {
    expect(isOpenableUrl('https://x/y')).toBe(true)
    expect(isOpenableUrl('HTTP://x')).toBe(true)
  })

  it('rejects every other scheme', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'argus://x', '/relative', '']) {
      expect(isOpenableUrl(url)).toBe(false)
    }
  })

  // Highest-value residual bypass class in a file just patched for a
  // Critical: a protocol-relative url (`//host/path`) inherits the CURRENT
  // page's scheme at click time, so it is never actually "http(s)" as far as
  // this string is concerned — it must be rejected the same as any other
  // non-http(s) string. A root-relative url (`/foo`) is not remote at all,
  // but is exactly the shape an attacker-controlled `record.url` could take
  // to target an unexpected in-app route.
  it('rejects a protocol-relative url', () => {
    expect(isOpenableUrl('//evil.example')).toBe(false)
    expect(isOpenableUrl('//evil.example/path')).toBe(false)
  })

  it('rejects a root-relative path', () => {
    expect(isOpenableUrl('/foo')).toBe(false)
  })
})
