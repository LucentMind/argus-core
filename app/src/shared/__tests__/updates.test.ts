import { describe, it, expect } from 'vitest'
import { describeUpdate, type UpdateStatus } from '../updates'

describe('describeUpdate', () => {
  it('covers every phase', () => {
    const cases: Array<[UpdateStatus, string]> = [
      [{ phase: 'idle' }, 'Argus is up to date'],
      [
        { phase: 'unsupported', reason: 'Updates are only available in a packaged build' },
        'Updates are only available in a packaged build'
      ],
      [{ phase: 'checking' }, 'Checking for updates…'],
      [{ phase: 'available', version: '1.1.0' }, 'Version 1.1.0 is available'],
      [{ phase: 'downloading', percent: 42 }, 'Downloading… 42%'],
      [{ phase: 'ready', version: '1.1.0' }, 'Version 1.1.0 is ready — restart to apply'],
      [{ phase: 'error', message: 'offline', at: 1 }, 'Update failed: offline']
    ]
    for (const [status, expected] of cases) expect(describeUpdate(status)).toBe(expected)
  })

  it('does not claim a failure came from a check — error is also produced by download()', () => {
    // Regression: the old UpdateSettings hardcoded `Check failed: ${message}` for every error,
    // which was wrong whenever the error phase was reached via a failed download.
    const fromDownload: UpdateStatus = { phase: 'error', message: 'disk full', at: 1 }
    expect(describeUpdate(fromDownload)).not.toMatch(/check failed/i)
    expect(describeUpdate(fromDownload)).toBe('Update failed: disk full')
  })

  describe('subject (Fix 4)', () => {
    it("words the pack-subject idle phase differently from Core's, which claims the whole app", () => {
      expect(describeUpdate({ phase: 'idle' }, 'pack')).toBe('No update available')
      expect(describeUpdate({ phase: 'idle' }, 'pack')).not.toBe('Argus is up to date')
    })

    it('defaults to the core subject — every existing call site is unaffected', () => {
      expect(describeUpdate({ phase: 'idle' })).toBe('Argus is up to date')
      expect(describeUpdate({ phase: 'idle' }, 'core')).toBe('Argus is up to date')
    })

    it('words every non-idle phase identically regardless of subject', () => {
      const cases: UpdateStatus[] = [
        { phase: 'checking' },
        { phase: 'available', version: '1.1.0' },
        { phase: 'downloading', percent: 10 },
        { phase: 'ready', version: '1.1.0' },
        { phase: 'error', message: 'offline', at: 1 }
      ]
      for (const status of cases) {
        expect(describeUpdate(status, 'pack')).toBe(describeUpdate(status, 'core'))
      }
    })
  })
})
