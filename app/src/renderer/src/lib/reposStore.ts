import { remoteToOwnerRepo } from '../../../shared/pr'

export interface CaseRepos {
  names: string[]
}

const EMPTY: CaseRepos = { names: [] }

/** The repo name a remote url implies: `HiveMindTest` for
 *  `https://github.com/JiaweiHan88/HiveMindTest.git` (any GitHub remote shape via
 *  remoteToOwnerRepo), last path segment minus `.git` for other hosts. */
function remoteRepoName(remote: string | null | undefined): string | null {
  if (!remote) return null
  const gh = remoteToOwnerRepo(remote)
  if (gh) return gh.repo
  const base =
    remote
      .split('/')
      .pop()
      ?.replace(/\.git$/, '') ?? ''
  return base.length > 0 ? base : null
}

/** Per-case linked-repo names — the dynamic citation domain. For each linked
 *  workspace this carries BOTH the directory basename and the remote-derived
 *  repo name: findings cite the GitHub name (the review prompt pins it), while
 *  a user's clone folder can be named anything, and a citation whose first
 *  segment misses this set renders as dead text. Plus imported ref names.
 *  Loaded by CaseWorkspace on mount and by the repos UI after link/unlink. */
class ReposStore {
  private byCase = new Map<string, CaseRepos>()
  private listeners = new Set<() => void>()

  get(caseSlug: string): CaseRepos {
    return this.byCase.get(caseSlug) ?? EMPTY
  }

  async load(caseSlug: string): Promise<void> {
    const [ws, refs] = await Promise.all([
      window.argus.workspaces.list(caseSlug),
      window.argus.workspaces.refs(caseSlug)
    ])
    const names: string[] = []
    const seen = new Set<string>()
    const add = (n: string | null): void => {
      if (!n) return
      const key = n.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      names.push(n)
    }
    for (const w of ws as Array<{ path: string; remote?: string | null }>) {
      add(w.path.split(/[\\/]/).pop() ?? w.path)
      add(remoteRepoName(w.remote))
    }
    for (const r of refs) add(remoteRepoName(r.remote))
    this.byCase.set(caseSlug, { names })
    this.emit()
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Test hook. */
  clearForTests(): void {
    this.byCase.clear()
    this.listeners.clear()
  }

  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}

export const reposStore = new ReposStore()
