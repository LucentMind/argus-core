export interface CaseRepos {
  names: string[]
}

const EMPTY: CaseRepos = { names: [] }

/** Per-case linked-repo names (basenames of linked workspaces + imported ref
 *  names) — the dynamic citation domain. Loaded by CaseWorkspace on mount and
 *  by the repos UI after link/unlink (see ReposSection, added in the
 *  follow-up task). */
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
    const fromWorkspaces = (ws as Array<{ path: string }>).map(
      (w) => w.path.split(/[\\/]/).pop() ?? w.path
    )
    const fromRefs = refs
      .map(
        (r) =>
          (r.remote ?? '')
            .split('/')
            .pop()
            ?.replace(/\.git$/, '') ?? ''
      )
      .filter((n) => n.length > 0)
    this.byCase.set(caseSlug, { names: [...fromWorkspaces, ...fromRefs] })
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
