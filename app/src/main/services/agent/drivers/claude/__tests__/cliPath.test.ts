import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveClaudeCliPath } from '../cliPath'

/**
 * Regression cover for the packaged-build Claude boot failure (2026-07-19): the SDK resolves
 * its bundled `claude.exe` to a path inside `app.asar`, spawn fails ENOENT, and the SDK
 * misreports it as "binary does not match this system's libc". Same root cause as the Copilot
 * CLI path — see resolveCopilotCliPath.
 */
describe('resolveClaudeCliPath', () => {
  const binName = process.platform === 'win32' ? 'claude.exe' : 'claude'

  // Native separators: asar.ts's regex handles both, but claudeBinaryPath goes through
  // path.dirname, which reads a backslash path as a single filename on POSIX. A hardcoded
  // windows fixture therefore tests the platform, not the asar rewrite.
  const resRoot = process.platform === 'win32' ? 'C:\\app\\resources' : '/app/resources'
  const pkgTail = ['node_modules', '@anthropic-ai', 'sdk-win32-x64']

  it('returns the unpacked twin when the SDK binary resolves inside an asar', () => {
    const got = resolveClaudeCliPath(() =>
      path.join(resRoot, 'app.asar', ...pkgTail, 'package.json')
    )
    expect(got).toBe(path.join(resRoot, 'app.asar.unpacked', ...pkgTail, binName))
  })

  /** Unpackaged runs must keep deferring to the SDK's own resolution — we only override to
   *  escape the asar, never to second-guess the SDK elsewhere. */
  it('returns null when the binary is not inside an asar', () => {
    expect(
      resolveClaudeCliPath(() => '/repo/node_modules/@anthropic-ai/sdk-linux-x64/package.json')
    ).toBeNull()
  })

  it('returns null when the platform package is not installed', () => {
    expect(
      resolveClaudeCliPath(() => {
        throw new Error('MODULE_NOT_FOUND')
      })
    ).toBeNull()
  })

  it('asks for the platform package matching this host', () => {
    const seen: string[] = []
    resolveClaudeCliPath((id) => {
      seen.push(id)
      return '/repo/node_modules/x/package.json'
    })
    expect(seen[0]).toBe(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`
    )
  })
})
