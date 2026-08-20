import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { msysAltPathFor, tildeAltPath } from '../skillAssetGate'

/**
 * The two path rewrites are pure string functions, tested here WITHOUT the filesystem and
 * WITHOUT `process.platform`, because both of their guards used to be untestable:
 *
 * - The MSYS rewrite's `process.platform !== 'win32'` check had zero coverage on any CI leg. The
 *   filesystem-backed tests that exercise it are `describe.skipIf(!isWin)`, so the macOS leg
 *   skipped them entirely and the Windows leg passed whether or not the guard existed — deleting
 *   it would have failed nothing, anywhere.
 * - The negative cases (`/usr/…`, `/config/…`, a bare `/c`) only ran on Windows for the same
 *   reason, even though the regexes they constrain are platform-independent.
 */
describe('msysAltPathFor', () => {
  it('rewrites the git-bash spelling of an absolute Windows path', () => {
    expect(msysAltPathFor('win32', '/c/Users/x/run.sh')).toBe('C:\\Users\\x\\run.sh')
    expect(msysAltPathFor('win32', '/d/argus/skills-user/s/run.sh')).toBe(
      'D:\\argus\\skills-user\\s\\run.sh'
    )
  })

  it('rewrites the path.resolve-mangled spelling the token loop produces', () => {
    // `path.resolve(<caseDir>, '/c/Users/x/run.sh')` reads the leading `/` as "root of the
    // current drive" and leaves the MSYS drive letter behind as a literal directory name.
    expect(msysAltPathFor('win32', 'C:\\c\\Users\\x\\run.sh')).toBe('C:\\Users\\x\\run.sh')
    expect(msysAltPathFor('win32', 'C:/c/Users/x/run.sh')).toBe('C:\\Users\\x\\run.sh')
    // The mangling drive and the MSYS drive are independent: the letter in the SECOND position
    // is the one the command named.
    expect(msysAltPathFor('win32', 'E:\\d\\argus\\run.sh')).toBe('D:\\argus\\run.sh')
  })

  it('uppercases the drive letter and keeps the rest of the path verbatim', () => {
    expect(msysAltPathFor('win32', '/c/Users/Jane/A b')).toBe('C:\\Users\\Jane\\A b')
  })

  it('rewrites only a single-letter first segment', () => {
    expect(msysAltPathFor('win32', '/usr/bin/env')).toBeNull()
    expect(msysAltPathFor('win32', '/config/x.sh')).toBeNull()
    expect(msysAltPathFor('win32', '/cc/Users/x/run.sh')).toBeNull()
    expect(msysAltPathFor('win32', '/1/Users/x/run.sh')).toBeNull()
  })

  it('needs something after the drive letter', () => {
    expect(msysAltPathFor('win32', '/c')).toBeNull()
    expect(msysAltPathFor('win32', '/c/')).toBeNull()
  })

  it('leaves an ordinary absolute path alone', () => {
    expect(msysAltPathFor('win32', 'C:\\Users\\x\\run.sh')).toBeNull()
    expect(msysAltPathFor('win32', 'run.sh')).toBeNull()
  })

  // The guard this file exists for. On Linux and macOS `/c/Users/x` is a perfectly ordinary
  // absolute path, and rewriting it would point the gate at a file the command never named.
  it('never rewrites off win32', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(msysAltPathFor(platform, '/c/Users/x/run.sh')).toBeNull()
      expect(msysAltPathFor(platform, 'C:\\c\\Users\\x\\run.sh')).toBeNull()
    }
  })
})

/**
 * `~` is a POSIX shell feature, so unlike the MSYS rewrite this one is NOT platform-gated: every
 * shell Argus spawns expands it, on every OS. `path.join` here so the expectations read the same
 * on win32 and POSIX — the separator is the platform's, the segments are what matter.
 */
describe('tildeAltPath', () => {
  const HOME = path.sep === '\\' ? 'C:\\Users\\Jane' : '/home/jane'

  it('expands a leading ~/ to the home directory', () => {
    expect(tildeAltPath('~/Argus/skills-user/s/run.sh', HOME)).toBe(
      path.join(HOME, 'Argus', 'skills-user', 's', 'run.sh')
    )
  })

  it('expands a leading ~\\ too — the spelling a Windows shell accepts', () => {
    expect(tildeAltPath('~\\Argus\\run.sh', HOME)).toBe(path.join(HOME, 'Argus', 'run.sh'))
  })

  // What `skillAssetContextForSegment` actually hands over: the token loop calls
  // `path.resolve(cwd, '~/Argus/x')` first, which glues the tilde on as a literal directory.
  it('expands the path.resolve-mangled spelling the token loop produces', () => {
    const mangled = path.resolve(path.join(HOME, 'Argus', 'cases', 'ACME-1'), '~/Argus/run.sh')
    expect(tildeAltPath(mangled, HOME)).toBe(path.join(HOME, 'Argus', 'run.sh'))
  })

  it('leaves a path with no bare ~ segment alone', () => {
    expect(tildeAltPath('/usr/bin/env', HOME)).toBeNull()
    expect(tildeAltPath('C:\\Users\\x\\run.sh', HOME)).toBeNull()
    expect(tildeAltPath('run.sh', HOME)).toBeNull()
  })

  // Documented limit: `~user/…` names ANOTHER user's home, which this module cannot resolve
  // without enumerating the system's users. It is listed in the gate's exclusion block instead.
  it('does not expand ~user — another user home is not this one', () => {
    expect(tildeAltPath('~notauser/x.sh', HOME)).toBeNull()
    expect(tildeAltPath('~root/x.sh', HOME)).toBeNull()
  })

  it('needs something after the ~ — a bare tilde names a directory, never an asset', () => {
    expect(tildeAltPath('~', HOME)).toBeNull()
    expect(tildeAltPath('~/', HOME)).toBeNull()
    expect(tildeAltPath('~\\', HOME)).toBeNull()
  })

  it('is not platform-gated — it answers the same wherever it runs', () => {
    expect(tildeAltPath('~/Argus/run.sh', '/home/jane')).toBe(
      path.join('/home/jane', 'Argus', 'run.sh')
    )
  })
})
