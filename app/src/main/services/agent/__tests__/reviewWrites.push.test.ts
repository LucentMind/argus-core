import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { addBinding } from '../../prBindings'
import { casePrWorktreeDir } from '../../prWorktree'
import { listFindings } from '../../findings'
import { appendFinding } from '../nativeTools'
import { pushReviewChange, type GitRunner } from '../reviewWrites'
import type { Runner } from '../../github'

let db: DatabaseSync
let home: string
let repoPath: string
let worktree: string

const headJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    headRefName: 'feature/guard',
    headRefOid: 'abc123',
    isCrossRepository: false,
    ...over
  })

const ghOk: Runner = async () => headJson()

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-revpush-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
  repoPath = path.join(home, 'clones', 'widget')
  fs.mkdirSync(repoPath, { recursive: true })
  // `updated_at` is NOT NULL with no default (db.ts:50) — omitting it fails the insert.
  const nowIso = new Date().toISOString()
  db.prepare(
    `INSERT INTO sessions (id, case_id, mode, created_at, updated_at) VALUES (1, ?, 'review', ?, ?)`
  ).run(getCase(db, 'c1')!.id, nowIso, nowIso)
  addBinding(db, 'c1', {
    repoPath,
    owner: 'acme',
    repo: 'widget',
    number: 42,
    url: 'https://github.com/acme/widget/pull/42',
    source: 'manual'
  })
  worktree = casePrWorktreeDir(home, 'c1', repoPath, 42)
  fs.mkdirSync(worktree, { recursive: true })
})

function seedFinding(): number {
  return seedFindingCiting('See [widget/src/guard.ts:17].')
}

function seedFindingCiting(markdown: string): number {
  return appendFinding(
    {
      db,
      argusHome: home,
      caseId: getCase(db, 'c1')!.id,
      caseSlug: 'c1',
      sessionId: 1,
      turnId: null
    },
    { title: 'F', markdown, suggestedChange: 'flip it' }
  ).findingId
}

/**
 * A git runner that answers each subcommand from a script and records the calls (and the cwd
 * each was run in, so multi-binding tests can prove the right worktree was touched).
 *
 * `!`-prefixed override values throw. `codes` lets a specific subcommand's thrown error carry
 * an exit code other than 1 — real `git merge-base --is-ancestor` exits 1 only for "not an
 * ancestor"; anything else (timeout, unresolvable sha) must propagate as a raw error instead of
 * being reported as staleness.
 */
function scriptedGit(
  over: Partial<Record<string, string>> = {},
  codes: Partial<Record<string, number>> = {}
): {
  git: GitRunner
  calls: string[][]
  cwds: string[]
} {
  const calls: string[][] = []
  const cwds: string[] = []
  const git: GitRunner = async (cwd, args) => {
    calls.push(args)
    cwds.push(cwd)
    const sub = args[0]
    if (sub in over) {
      const v = over[sub] as string
      if (v.startsWith('!')) {
        throw Object.assign(new Error(v.slice(1)), { code: codes[sub] ?? 1 })
      }
      return v
    }
    if (sub === 'status') return ' M src/guard.ts'
    if (sub === 'merge-base') return ''
    if (sub === 'rev-parse') return 'newsha1'
    return ''
  }
  return { git, calls, cwds }
}

describe('pushReviewChange', () => {
  it('commits the worktree and pushes an explicit refspec to the PR branch', async () => {
    const { git, calls } = scriptedGit()
    const id = seedFinding()
    const out = await pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
      findingId: id,
      commitMessage: 'fix: flip the inverted guard'
    })
    expect(out).toMatch(/newsha1/)
    expect(out).toMatch(/feature\/guard/)
    expect(calls).toContainEqual(['add', '-A'])
    expect(calls).toContainEqual(['commit', '-m', 'fix: flip the inverted guard'])
    expect(calls).toContainEqual(['push', 'origin', 'HEAD:refs/heads/feature/guard'])
    expect(calls.flat()).not.toContain('--force')
    expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.pushedSha).toBe('newsha1')
  })

  it('refuses an empty commit message before touching git or gh', async () => {
    const { git, calls } = scriptedGit()
    const gh: Runner = async () => {
      throw new Error('gh must not be called')
    }
    await expect(
      pushReviewChange({ db, argusHome: home, gh, git }, 'c1', {
        findingId: seedFinding(),
        commitMessage: '   '
      })
    ).rejects.toThrow(/empty/i)
    expect(calls).toEqual([])
  })

  it('refuses a fork PR before touching git', async () => {
    const { git, calls } = scriptedGit()
    const gh: Runner = async () => headJson({ isCrossRepository: true })
    await expect(
      pushReviewChange({ db, argusHome: home, gh, git }, 'c1', {
        findingId: seedFinding(),
        commitMessage: 'm'
      })
    ).rejects.toThrow(/fork/i)
    expect(calls).toEqual([])
  })

  it('refuses when the worktree has nothing to commit', async () => {
    // Clean AND at the PR's head sha (abc123, per ghOk/headJson) — genuinely nothing to do.
    // Post-fix, "clean" alone isn't enough: a clean-but-ahead worktree (a prior commit whose
    // push failed) has to fall through to a bare push instead — see the "ahead" test below.
    const { git, calls } = scriptedGit({ status: '', 'rev-parse': 'abc123' })
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: seedFinding(),
        commitMessage: 'm'
      })
    ).rejects.toThrow(/no uncommitted changes/i)
    expect(calls.map((c) => c[0])).not.toContain('commit')
  })

  it('refuses when the worktree is behind the PR head', async () => {
    const { git, calls } = scriptedGit({ 'merge-base': '!not an ancestor' })
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: seedFinding(),
        commitMessage: 'm'
      })
    ).rejects.toThrow(/behind PR #42/i)
    expect(calls.map((c) => c[0])).not.toContain('commit')
  })

  it('propagates a merge-base failure that is not exit code 1 as a raw error, not staleness', async () => {
    const { git, calls } = scriptedGit(
      { 'merge-base': '!fatal: unable to resolve ref feature/guard' },
      { 'merge-base': 128 }
    )
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: seedFinding(),
        commitMessage: 'm'
      })
    ).rejects.toThrow(/unable to resolve ref/)
    expect(calls.map((c) => c[0])).not.toContain('commit')
  })

  it('pushes without committing when the tree is clean but HEAD is already ahead of the PR head', async () => {
    // Simulates a retry after a previous call committed locally but the push itself failed:
    // clean tree, HEAD != the PR's last-seen head sha (abc123).
    const { git, calls } = scriptedGit({ status: '', 'rev-parse': 'aheadsha1' })
    const id = seedFinding()
    const out = await pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
      findingId: id,
      commitMessage: 'm'
    })
    expect(calls.map((c) => c[0])).not.toContain('add')
    expect(calls.map((c) => c[0])).not.toContain('commit')
    expect(calls).toContainEqual(['push', 'origin', 'HEAD:refs/heads/feature/guard'])
    expect(out).toMatch(/aheadsha1/)
    expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.pushedSha).toBe('aheadsha1')
  })

  it('refuses when the PR was never checked out locally', async () => {
    fs.rmSync(worktree, { recursive: true, force: true })
    const { git } = scriptedGit()
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: seedFinding(),
        commitMessage: 'm'
      })
    ).rejects.toThrow(/no local checkout/i)
  })

  it('surfaces a rejected push and records nothing', async () => {
    const { git } = scriptedGit({
      push: '! ! [rejected] feature/guard -> feature/guard (fetch first)'
    })
    const id = seedFinding()
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: id,
        commitMessage: 'm'
      })
    ).rejects.toThrow(/rejected/)
    expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.pushedSha).toBeNull()
  })
})

describe('pushReviewChange — multi-binding disambiguation', () => {
  /** Adds a second binding (gadget/#7) and returns its repoPath. Added AFTER widget/#42, so
   *  listBindings (newest first) puts it at index 0 — any bindings[0] fallback would target
   *  it, which is exactly the bug these tests guard against. */
  function addSecondBinding(): string {
    const repoPath2 = path.join(home, 'clones', 'gadget')
    fs.mkdirSync(repoPath2, { recursive: true })
    addBinding(db, 'c1', {
      repoPath: repoPath2,
      owner: 'acme',
      repo: 'gadget',
      number: 7,
      url: 'https://github.com/acme/gadget/pull/7',
      source: 'manual'
    })
    return repoPath2
  }

  it('refuses an ambiguous citation when two PRs are bound and neither name matches', async () => {
    addSecondBinding()
    const { git, calls } = scriptedGit()
    const id = seedFindingCiting('See [other/src/x.ts:1].')
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: id,
        commitMessage: 'm'
      })
    ).rejects.toThrow(/bound pull requests/i)
    expect(calls).toEqual([])
  })

  it('pushes to the PR the citation names, not bindings[0]', async () => {
    addSecondBinding()
    const { git, cwds } = scriptedGit()
    // gh discriminates by --repo so the resolved PR is provable, not assumed.
    const gh: Runner = async (_cmd, args) => {
      const repo = args[args.indexOf('--repo') + 1]
      if (repo === 'acme/gadget') {
        return JSON.stringify({
          headRefName: 'gadget-branch',
          headRefOid: 'gadgetsha',
          isCrossRepository: false
        })
      }
      return headJson()
    }
    const id = seedFindingCiting('See [widget/src/guard.ts:17].') // names widget/#42, not gadget/#7
    const out = await pushReviewChange({ db, argusHome: home, gh, git }, 'c1', {
      findingId: id,
      commitMessage: 'm'
    })
    expect(out).toContain('#42')
    expect(out).not.toContain('#7')
    expect(out).toContain('feature/guard')
    expect(cwds.every((c) => c === worktree)).toBe(true)
  })

  it('refuses an uncited finding when two PRs are bound, distinctly from a bad citation', async () => {
    addSecondBinding()
    const { git, calls } = scriptedGit()
    const id = seedFindingCiting('No citation here at all.')
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: id,
        commitMessage: 'm'
      })
    ).rejects.toThrow(/no citation/i)
    expect(calls).toEqual([])
  })

  it('rejects a same-repo citation when two PRs from the same repo are bound (#42/#43)', async () => {
    // Same owner/repo, different number: pr_bindings' unique key is (case_id, owner, repo,
    // number), so both can be bound to one case (IPC.prLinkMany from a single search does
    // exactly this). Both match the `widget/` citation prefix.
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 43,
      url: 'https://github.com/acme/widget/pull/43',
      source: 'manual'
    })
    const { git, calls } = scriptedGit()
    const id = seedFindingCiting('See [widget/src/guard.ts:17].')
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: id,
        commitMessage: 'm'
      })
    ).rejects.toThrow(/bound pull requests in widget/i)
    expect(calls).toEqual([])
  })

  it('an explicit pr argument picks the right one of two same-repo bindings', async () => {
    // #43 is added AFTER #42, so listBindings (newest first) puts #43 at bindings[0] — an
    // implementation that parsed `pr`, did the unknown-pr membership check, and then still
    // returned bindings[0] regardless would pass a "pick #43" assertion by coincidence. Picking
    // #42 (already bound + worktree-materialized by the outer beforeEach, and NOT bindings[0])
    // is what actually proves pr selects the binding.
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 43,
      url: 'https://github.com/acme/widget/pull/43',
      source: 'manual'
    })
    const gh: Runner = async (_cmd, args) => {
      const repo = args[args.indexOf('--repo') + 1]
      const number = args[2]
      if (repo === 'acme/widget' && number === '43') {
        return JSON.stringify({
          headRefName: 'pr43-branch',
          headRefOid: 'sha43',
          isCrossRepository: false
        })
      }
      return headJson() // #42's head
    }
    const { git, cwds } = scriptedGit()
    const id = seedFindingCiting('See [widget/src/guard.ts:17].')
    const out = await pushReviewChange({ db, argusHome: home, gh, git }, 'c1', {
      findingId: id,
      commitMessage: 'm',
      expectPr: 'acme/widget#42'
    })
    expect(out).toContain('#42')
    expect(out).not.toContain('#43')
    expect(cwds.every((c) => c === worktree)).toBe(true)
  })

  it('a pr argument naming a PR that is not bound throws', async () => {
    const { git, calls } = scriptedGit()
    const id = seedFinding()
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: id,
        commitMessage: 'm',
        expectPr: 'acme/widget#999'
      })
    ).rejects.toThrow(/acme\/widget#999/i)
    expect(calls).toEqual([])
  })

  it('rejects a pr that contradicts the citation instead of silently pushing to the wrong PR', async () => {
    // #42 (from the outer beforeEach) is bound alongside acme/gadget#7. The finding cites
    // [widget/...], but the agent passes pr: acme/gadget#7 — a genuine contradiction. Without
    // this check, `match` (gadget#7) would win outright and this call would go on to commit and
    // push to gadget's branch for a change described against widget's citation.
    addBinding(db, 'c1', {
      repoPath: null,
      owner: 'acme',
      repo: 'gadget',
      number: 7,
      url: 'https://github.com/acme/gadget/pull/7',
      source: 'manual'
    })
    const { git, calls } = scriptedGit()
    const id = seedFindingCiting('See [widget/src/guard.ts:17].')
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: id,
        commitMessage: 'm',
        expectPr: 'acme/gadget#7'
      })
    ).rejects.toThrow(/widget/i)
    expect(calls).toEqual([])
  })
})

describe('pushReviewChange against real git', () => {
  it('lands the commit on the PR head branch of a real remote', async () => {
    const origin = path.join(home, 'origin.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', origin])
    const seed = path.join(home, 'seed')
    execFileSync('git', ['clone', origin, seed])
    const g = (...args: string[]): void => {
      execFileSync('git', args, { cwd: seed })
    }
    fs.writeFileSync(path.join(seed, 'file.txt'), 'one\n')
    g('add', '-A')
    g('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'seed')
    g('push', 'origin', 'main:refs/heads/feature/guard')
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seed }).toString().trim()

    fs.rmSync(worktree, { recursive: true, force: true })
    execFileSync('git', ['clone', origin, worktree])
    execFileSync('git', ['switch', '--detach', 'origin/feature/guard'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: worktree })
    fs.writeFileSync(path.join(worktree, 'file.txt'), 'two\n')

    const gh: Runner = async () =>
      JSON.stringify({
        headRefName: 'feature/guard',
        headRefOid: baseSha,
        isCrossRepository: false
      })
    const id = seedFinding()
    const out = await pushReviewChange({ db, argusHome: home, gh }, 'c1', {
      findingId: id,
      commitMessage: 'fix: flip the inverted guard'
    })

    const remoteLog = execFileSync(
      'git',
      ['log', '-1', '--format=%s', 'refs/heads/feature/guard'],
      {
        cwd: origin
      }
    )
      .toString()
      .trim()
    expect(remoteLog).toBe('fix: flip the inverted guard')
    expect(out).toContain('feature/guard')
    expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.pushedSha).toHaveLength(40)
  }, 30_000)
})
