import { describe, it, expect } from 'vitest'
import { ghStatus, type ExecLike } from '../sourceControl'

const exec =
  (
    impl: Record<string, { stdout?: string; stderr?: string; err?: NodeJS.ErrnoException }>
  ): ExecLike =>
  async (_cmd, args) => {
    const key = args[0] === '--version' ? 'version' : 'auth'
    const r = impl[key]
    if (r?.err) throw Object.assign(r.err, { stderr: r.stderr ?? '' })
    return { stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' }
  }

describe('ghStatus', () => {
  it('installed + authenticated: version and login parsed', async () => {
    const s = await ghStatus(
      exec({
        version: { stdout: 'gh version 2.96.0 (2026-07-02)\nhttps://github.com/cli/cli' },
        auth: {
          stdout: '',
          stderr: 'github.com\n  ✓ Logged in to github.com account jiawiehan (keyring)\n'
        }
      })
    )
    expect(s).toEqual({
      installed: true,
      version: 'gh version 2.96.0 (2026-07-02)',
      authenticated: true,
      login: 'jiawiehan',
      detail: 'Logged in to github.com account jiawiehan'
    })
  })

  it('tolerates older gh output ("Logged in to ... as ...")', async () => {
    const s = await ghStatus(
      exec({
        version: { stdout: 'gh version 2.40.0 (2023-11-14)' },
        auth: {
          stdout: '',
          stderr: 'github.com\n  ✓ Logged in to github.com as olduser (keyring)\n'
        }
      })
    )
    expect(s.authenticated).toBe(true)
    expect(s.login).toBe('olduser')
  })

  it('installed but not authenticated', async () => {
    const notLoggedIn = Object.assign(new Error('exit 1'), { code: 1 as unknown as string })
    const s = await ghStatus(
      exec({
        version: { stdout: 'gh version 2.96.0 (2026-07-02)' },
        auth: { err: notLoggedIn, stderr: 'You are not logged into any GitHub hosts.\n' }
      })
    )
    expect(s.installed).toBe(true)
    expect(s.authenticated).toBe(false)
    expect(s.login).toBeNull()
    expect(s.detail).toContain('not logged in')
  })

  it('gh not installed', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    const s = await ghStatus(exec({ version: { err: enoent } }))
    expect(s).toEqual({
      installed: false,
      version: null,
      authenticated: false,
      login: null,
      detail: 'gh not installed'
    })
  })
})
