import { describe, expect, it } from 'vitest'
import { checkDriverBinaries, classifyProbe, runProviderSmoke } from '../smokeProviders'

/**
 * The CI gate. Spawning `--version` answers "can this binary be launched?" directly, with no
 * dependence on credentials — which matters because CI has none, and the probe-based check
 * this replaced would have scored a healthy logged-out build as FAILED (the Claude probe
 * reports 'claude CLI exited before initializing' with no auth, which no auth-verdict
 * allowlist should be expected to recognize).
 */
describe('checkDriverBinaries', () => {
  const ok = (): { status: number; error?: Error; stdout: string } => ({
    status: 0,
    stdout: '2.1.205 (Claude Code)'
  })

  it('passes when every binary answers --version with exit 0', () => {
    const result = checkDriverBinaries({ a: '/bin/a', b: '/bin/b' }, ok)
    expect(result.ok).toBe(true)
    expect(result.results.map((r) => r.kind)).toEqual(['a', 'b'])
    expect(result.results[0].detail).toContain('2.1.205')
  })

  it('fails on the ENOENT the asar path produced', () => {
    const result = checkDriverBinaries({ a: '/inside/app.asar/bin' }, () => ({
      status: null,
      error: Object.assign(new Error('spawn /inside/app.asar/bin ENOENT'), { code: 'ENOENT' }),
      stdout: ''
    }))
    expect(result.ok).toBe(false)
    expect(result.results[0].detail).toContain('ENOENT')
  })

  it('fails on a non-zero exit', () => {
    const result = checkDriverBinaries({ a: '/bin/a' }, () => ({ status: 1, stdout: '' }))
    expect(result.ok).toBe(false)
  })

  /** An unresolvable binary is a packaging failure, not a pass. */
  it('fails when a driver has no resolvable binary path', () => {
    const result = checkDriverBinaries({ a: null }, ok)
    expect(result.ok).toBe(false)
    expect(result.results[0].detail).toMatch(/could not be resolved/i)
  })

  it('spawns each binary with --version', () => {
    const seen: Array<[string, string[]]> = []
    checkDriverBinaries({ a: '/bin/a' }, (bin, args) => {
      seen.push([bin, args])
      return ok()
    })
    expect(seen).toEqual([['/bin/a', ['--version']]])
  })
})

/**
 * The packaged smoke test asserts one thing only: every driver's CLI binary *launched*.
 * It deliberately does NOT assert authentication — CI has no credentials, and "not
 * authenticated" is a healthy answer that proves the binary ran. What must fail the build is
 * a binary that could not be spawned at all, which is how the app.asar path bug shipped twice.
 */
describe('classifyProbe', () => {
  it('passes an authenticated probe', () => {
    expect(classifyProbe({ ok: true, detail: 'copilot ready (octocat via oauth)' }).launched).toBe(
      true
    )
  })

  it('passes an unauthenticated probe — the binary still launched', () => {
    expect(
      classifyProbe({ ok: false, detail: 'Copilot not authenticated — run `gh auth login`' })
        .launched
    ).toBe(true)
    expect(classifyProbe({ ok: false, detail: 'Log in with `claude login`.' }).launched).toBe(true)
  })

  it('fails the exact messages both asar bugs produced', () => {
    // Copilot, pre-fix.
    expect(
      classifyProbe({
        ok: false,
        detail: 'Copilot runtime not found — check the CLI path or reinstall @github/copilot-sdk'
      }).launched
    ).toBe(false)
    expect(
      classifyProbe({ ok: false, detail: 'CLI server exited unexpectedly with code 0' }).launched
    ).toBe(false)
    // Claude, pre-fix — note the SDK blames libc; the real errno is ENOENT.
    expect(
      classifyProbe({
        ok: false,
        detail:
          "Claude Code native binary at C:\\app\\resources\\app.asar\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe exists but failed to launch. This usually means the binary does not match this system's libc"
      }).launched
    ).toBe(false)
  })

  it('fails raw spawn errors and probe timeouts', () => {
    expect(classifyProbe({ ok: false, detail: 'spawn claude.exe ENOENT' }).launched).toBe(false)
    expect(
      classifyProbe({ ok: false, detail: 'Copilot probe timed out after 10000ms' }).launched
    ).toBe(false)
  })

  /**
   * Fails closed. A denylist of known failure phrases scored the Copilot jsonrpc teardown
   * message as "launched" (observed 2026-07-19 while verifying this very check), so a
   * Copilot-only regression would have passed the gate. Anything not recognizably an auth
   * verdict is a failure — a false alarm is cheap, a false pass defeats the check.
   */
  it('fails an unrecognized failure detail rather than assuming the binary ran', () => {
    expect(
      classifyProbe({ ok: false, detail: 'Cannot call write after a stream was destroyed' })
        .launched
    ).toBe(false)
    expect(classifyProbe({ ok: false, detail: 'something nobody has seen before' }).launched).toBe(
      false
    )
    expect(classifyProbe({ ok: false }).launched).toBe(false)
  })

  /** A driver whose probe throws must fail loudly, not be scored as "launched". */
  it('fails when the probe throws', () => {
    expect(classifyProbe(new Error('boom')).launched).toBe(false)
  })
})

describe('runProviderSmoke', () => {
  it('probes every driver and fails overall if any binary did not launch', async () => {
    const result = await runProviderSmoke({
      good: {
        probeAuth: async () => ({ ok: false, detail: 'not authenticated' })
      } as never,
      bad: {
        probeAuth: async () => ({ ok: false, detail: 'spawn ENOENT' })
      } as never
    })
    expect(result.ok).toBe(false)
    expect(result.results.find((r) => r.kind === 'good')?.launched).toBe(true)
    expect(result.results.find((r) => r.kind === 'bad')?.launched).toBe(false)
  })

  it('passes when every driver launched', async () => {
    const result = await runProviderSmoke({
      a: { probeAuth: async () => ({ ok: true, detail: 'ready' }) } as never,
      b: { probeAuth: async () => ({ ok: false, detail: 'run `claude login`' }) } as never
    })
    expect(result.ok).toBe(true)
  })

  it('scores a driver whose probe rejects as not launched', async () => {
    const result = await runProviderSmoke({
      a: {
        probeAuth: async () => {
          throw new Error('runtime gone')
        }
      } as never
    })
    expect(result.ok).toBe(false)
    expect(result.results[0].detail).toContain('runtime gone')
  })
})
