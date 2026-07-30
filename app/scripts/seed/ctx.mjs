import path from 'node:path'

export const SLUGS = [
  'HMT-1-burst-token',
  'HMT-2-green',
  'HMT-3-cancelled',
  'HMT-4-nochecks',
  'SYN-5-edge'
]

export const PR_NUMBERS = {
  'HMT-1-burst-token': 4,
  'HMT-2-green': 6,
  'HMT-3-cancelled': 7,
  'HMT-4-nochecks': 5,
  'SYN-5-edge': 999
}

/** Shared state every seed module receives. `db` is null in unit tests. */
export function createCtx({ argusHome, db }) {
  return {
    argusHome,
    db,
    SLUGS,
    PR_NUMBERS,
    nowIso: () => new Date().toISOString(),
    caseDir: (slug) => path.join(argusHome, 'cases', slug),
    repoDir: (name) => path.join(argusHome, 'repos', name),
    // Mirrors casePrWorktreeDir() in src/main/services/prWorktree.ts.
    worktreeDir: (repo, slug, pr) => path.join(argusHome, 'worktrees', `${repo}-${slug}-pr${pr}`)
  }
}
