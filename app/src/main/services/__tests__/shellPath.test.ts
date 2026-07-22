import { describe, it, expect, vi } from 'vitest'
import { mergePath, hydratePathFromLoginShell, type ShellPathDeps } from '../shellPath'

describe('mergePath', () => {
  it('appends captured entries missing from current, preserving current order first', () => {
    expect(mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin')).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin'
    )
  })

  it('never removes or reorders existing entries', () => {
    expect(mergePath('/b:/a', '/a:/b:/c')).toBe('/b:/a:/c')
  })

  it('filters empty segments', () => {
    expect(mergePath('/usr/bin::/bin', ':/opt/homebrew/bin:')).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin'
    )
  })

  it('handles empty current', () => {
    expect(mergePath('', '/opt/homebrew/bin:/usr/bin')).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('handles empty captured', () => {
    expect(mergePath('/usr/bin:/bin', '')).toBe('/usr/bin:/bin')
  })
})

describe('hydratePathFromLoginShell', () => {
  const deps = (over: Partial<ShellPathDeps> = {}): ShellPathDeps & { env: NodeJS.ProcessEnv } => ({
    platform: 'darwin',
    isPackaged: true,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' },
    run: async () => '/opt/homebrew/bin:/usr/bin:/bin',
    ...over
  })

  it('merges the captured login-shell PATH into env.PATH', async () => {
    const d = deps()
    await hydratePathFromLoginShell(d)
    expect(d.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin')
  })

  it('spawns $SHELL as an interactive login shell', async () => {
    const run = vi.fn(async () => '/opt/homebrew/bin')
    const d = deps({ run, env: { PATH: '/usr/bin', SHELL: '/bin/bash' } })
    await hydratePathFromLoginShell(d)
    expect(run).toHaveBeenCalledWith('/bin/bash', [
      '-ilc',
      'command -v printf >/dev/null 2>&1 && printf %s "$PATH"'
    ])
  })

  it('falls back to /bin/zsh when SHELL is unset', async () => {
    const run = vi.fn<(shell: string, args: string[]) => Promise<string>>(
      async () => '/opt/homebrew/bin'
    )
    const d = deps({ run, env: { PATH: '/usr/bin' } })
    await hydratePathFromLoginShell(d)
    expect(run.mock.calls[0][0]).toBe('/bin/zsh')
  })

  it('leaves PATH untouched when the runner throws (spawn error / timeout)', async () => {
    const d = deps({
      run: async () => {
        throw new Error('timed out')
      }
    })
    await hydratePathFromLoginShell(d)
    expect(d.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
  })

  it('leaves PATH untouched when the shell prints nothing', async () => {
    const d = deps({ run: async () => '  ' })
    await hydratePathFromLoginShell(d)
    expect(d.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
  })

  it('skips on win32 without calling the runner', async () => {
    const run = vi.fn(async () => '/opt/homebrew/bin')
    const d = deps({ platform: 'win32', run })
    await hydratePathFromLoginShell(d)
    expect(run).not.toHaveBeenCalled()
    expect(d.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
  })

  it('skips in dev (isPackaged false) without calling the runner', async () => {
    const run = vi.fn(async () => '/opt/homebrew/bin')
    const d = deps({ isPackaged: false, run })
    await hydratePathFromLoginShell(d)
    expect(run).not.toHaveBeenCalled()
    expect(d.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
  })

  it('runs on linux packaged builds', async () => {
    const d = deps({ platform: 'linux' })
    await hydratePathFromLoginShell(d)
    expect(d.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin')
  })
})
