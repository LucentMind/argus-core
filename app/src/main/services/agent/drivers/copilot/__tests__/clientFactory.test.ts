import { describe, expect, it } from 'vitest'
import { resolveCopilotCliPath } from '../client'

/**
 * Regression cover for the Electron-only Copilot boot failure: the SDK resolves its
 * bundled CLI to the platform package's `index.js` and spawns `process.execPath` for it,
 * which in the Electron main process is `electron.exe` — it exits 0 immediately and the
 * SDK reports "CLI server exited unexpectedly with code 0". We must hand the SDK the
 * native executable instead, so no Node launcher is involved.
 */
describe('resolveCopilotCliPath', () => {
  it('resolves the platform package entry, not a .js launcher script', () => {
    const seen: string[] = []
    const got = resolveCopilotCliPath((id) => {
      seen.push(id)
      return `/pkgs/${id}/copilot.exe`
    })
    expect(got).toBe(`/pkgs/@github/copilot-${process.platform}-${process.arch}/copilot.exe`)
    expect(got?.endsWith('.js')).toBe(false)
    expect(seen[0]).toBe(`@github/copilot-${process.platform}-${process.arch}`)
  })

  it('returns null when no platform package is installed, deferring to the SDK error', () => {
    expect(
      resolveCopilotCliPath(() => {
        throw new Error('MODULE_NOT_FOUND')
      })
    ).toBeNull()
  })

  it('resolves the real installed platform binary in this workspace', () => {
    const got = resolveCopilotCliPath()
    expect(got).toBeTruthy()
    expect(got?.endsWith('.js')).toBe(false)
  })
})
