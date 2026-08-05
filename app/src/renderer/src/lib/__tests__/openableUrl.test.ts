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
})
