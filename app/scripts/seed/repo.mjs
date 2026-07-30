import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REMOTE = 'https://github.com/JiaweiHan88/HiveMindTest.git'

/** Any sha that is not a real HEAD renders the "code moved" badge; findings.head_sha
 *  is stored text and never dereferenced, so this need not resolve to a commit. */
export const STALE_HEAD = 'b994f1a61e2ea27c9c0ae9ec8a94f8a3d4302427'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/**
 * Clone HiveMindTest into the home and check out one worktree per real pull
 * request. The primary checkout at C:\Users\Power\HiveMindTest is never touched:
 * a fixture must not operate on a working tree the user has open.
 */
export function seedRepos(ctx) {
  const hmtDir = ctx.repoDir('hmt')
  fs.mkdirSync(path.dirname(hmtDir), { recursive: true })
  if (!fs.existsSync(path.join(hmtDir, '.git'))) {
    fs.rmSync(hmtDir, { recursive: true, force: true })
    execFileSync('git', ['clone', REMOTE, hmtDir], { encoding: 'utf8' })
  } else {
    git(hmtDir, 'fetch', 'origin', '--prune')
  }

  const worktrees = {}
  for (const slug of ctx.SLUGS) {
    if (slug === 'SYN-5-edge') continue
    const pr = ctx.PR_NUMBERS[slug]
    const dir = ctx.worktreeDir('hmt', slug, pr)
    // `git worktree add` refuses an existing path, and a stale worktree left on
    // disk after a prune is an empty directory that later git commands would
    // resolve against the MAIN checkout instead. Remove both records and files.
    try {
      git(hmtDir, 'worktree', 'remove', '--force', dir)
    } catch {
      /* not registered — fall through to the rm below */
    }
    fs.rmSync(dir, { recursive: true, force: true })
    git(hmtDir, 'fetch', 'origin', `pull/${pr}/head:seed-pr${pr}`, '--force')
    git(hmtDir, 'worktree', 'add', '--force', dir, `seed-pr${pr}`)
    worktrees[slug] = { dir, head: git(dir, 'rev-parse', 'HEAD') }
  }

  // Local-only repository for the fabricated case, so its worktree HEAD is real
  // even though its pull request is not.
  const syntheticDir = ctx.repoDir('synthetic-widget')
  fs.rmSync(syntheticDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(syntheticDir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(syntheticDir, 'src', 'widget.js'), '// synthetic fixture\n')
  git(syntheticDir, 'init', '-q', '-b', 'main')
  git(syntheticDir, 'config', 'user.email', 'seed@example.com')
  git(syntheticDir, 'config', 'user.name', 'Argus Seed')
  git(syntheticDir, 'add', '-A')
  git(syntheticDir, 'commit', '-q', '-m', 'synthetic fixture head')
  const synDir = ctx.worktreeDir('synthetic-widget', 'SYN-5-edge', 999)
  fs.rmSync(synDir, { recursive: true, force: true })
  git(syntheticDir, 'worktree', 'add', '--force', synDir, 'main')
  worktrees['SYN-5-edge'] = { dir: synDir, head: git(synDir, 'rev-parse', 'HEAD') }

  if (Object.values(worktrees).some((w) => w.head === STALE_HEAD)) {
    throw new Error('unlucky sha collision — change STALE_HEAD')
  }
  return { hmtDir, syntheticDir, worktrees, staleHead: STALE_HEAD }
}
