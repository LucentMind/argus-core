import fs from 'node:fs'
import path from 'node:path'
import { sharedReferencesDir } from './skillsDir'
import { refTier, refTitle } from './refSync/refFrontmatter'
import {
  findMentions,
  needlesFor,
  type CorpusItem,
  type ReferenceHit
} from '../../shared/corpusSearch'
import type { AuthoringKind } from '../../shared/authoringIpc'

/** The two filesystem reads this service makes, injected so its tests need no disk. */
export interface CorpusFs {
  readDir(dir: string): string[]
  readFile(file: string): string
}

export interface CorpusDeps {
  argusHome: string
  /**
   * The tier-winning skills, already resolved. Injected rather than calling `resolveSkills`
   * here so this service never has to know about `AgentAccess` — `index.ts` already has both,
   * and the same closure feeds `skillsPayload()`.
   */
  listSkills: () => { name: string; dir: string; description: string; tier: string }[]
  fs?: CorpusFs
}

const realFs: CorpusFs = {
  readDir: (dir) => fs.readdirSync(dir),
  readFile: (file) => fs.readFileSync(file, 'utf8')
}

/**
 * The editor window's view of every asset it could open (spec §6.2) and of what cites what
 * (§6.3).
 *
 * Read on demand, not cached. `list()` is NOT only user-initiated any more: `useEditorAssets`
 * (renderer `lib/editorAssets.ts`) calls `window.argus.editor.corpus()` on mount, on demand when
 * the palette opens, and on every `skills:changed` / `refsync:changed` broadcast — so it re-reads
 * the full body of every reference (to parse frontmatter) on every skill save or reference sync
 * while an editor window is open, blocking main for that read each time. A cache here would be a
 * third copy of a truth that already has two (`skills:list` and `refsync:get`) and would need
 * invalidating on every fork, claim and sync — a real design change with its own cost/benefit,
 * not something to bolt on incidentally. Left uncached deliberately; the next reader should not
 * have to re-derive that this is now a hot path rather than a rare one.
 *
 * Bodies never cross the IPC boundary: `findReferences` takes the query and returns only matched
 * lines. Shipping the corpus to the renderer would put an unbounded payload on the channel and
 * re-ship it on every search.
 */
export class EditorCorpusService {
  private readonly io: CorpusFs

  constructor(private readonly deps: CorpusDeps) {
    this.io = deps.fs ?? realFs
  }

  private refsDir(): string {
    return sharedReferencesDir(this.deps.argusHome)
  }

  /** Reference filenames, or `[]` when the directory is absent — an ARGUS_HOME that has never
   *  synced is normal, not an error.
   *
   *  FLAT ON PURPOSE — do not "fix" this to use listReferenceFiles. This list is what the editor
   *  window may OPEN AS A BUFFER, and a buffer is only useful if it can be saved: writeReference
   *  runs REF_TARGET_RE, which rejects every path separator. Listing a nested reference here
   *  would hand the user an editable pane whose save is refused. Nested references are read-only
   *  by design — visible in the Library, INDEX.md, search, usage stats and the agent prompt, and
   *  editable nowhere. The one cost is that INDEX.md's link to a nested reference does not
   *  resolve in the editor's link decoration (mdLinks.resolveLink matches against this list). */
  private refFiles(): string[] {
    try {
      return this.io.readDir(this.refsDir()).filter((f) => f.toLowerCase().endsWith('.md'))
    } catch {
      return []
    }
  }

  /** Body of an asset, or null when it cannot be read. A skill directory with no `SKILL.md`
   *  is real (see `skillsIndexForDistill` in index.ts) and must not throw here.
   *
   *  `skills` is the caller's already-resolved `listSkills()` result: `findReferences` calls
   *  this once per corpus item, and `listSkills` in production is a synchronous `readdirSync` +
   *  per-skill `readFileSync` closure, so re-deriving it here would turn one public call into
   *  N+1 filesystem sweeps. */
  private body(
    kind: AuthoringKind,
    name: string,
    skills: { name: string; dir: string }[]
  ): string | null {
    try {
      if (kind === 'reference') return this.io.readFile(path.join(this.refsDir(), name))
      const skill = skills.find((s) => s.name === name)
      if (!skill) return null
      return this.io.readFile(path.join(skill.dir, 'SKILL.md'))
    } catch {
      return null
    }
  }

  /** Builds the full corpus from an already-resolved skills list, so callers that also need
   *  `body()` afterwards (`findReferences`) can share one `listSkills()` call instead of each
   *  method fetching its own. */
  private buildList(skills: { name: string; description: string; tier: string }[]): CorpusItem[] {
    const skillItems: CorpusItem[] = skills.map((s) => ({
      kind: 'skill' as const,
      name: s.name,
      title: '',
      description: s.description,
      tier: s.tier
    }))
    const references: CorpusItem[] = []
    for (const file of this.refFiles()) {
      let raw: string
      try {
        raw = this.io.readFile(path.join(this.refsDir(), file))
      } catch {
        // A file listed by readdir and unreadable a moment later is a delete mid-scan. Skipping
        // it is right: it is no longer openable either.
        continue
      }
      references.push({
        kind: 'reference',
        name: file,
        title: refTitle(raw) ?? '',
        description: '',
        tier: refTier(raw)
      })
    }
    return [...skillItems, ...references]
  }

  list(): CorpusItem[] {
    return this.buildList(this.deps.listSkills())
  }

  findReferences(target: { kind: AuthoringKind; name: string }): ReferenceHit[] {
    const skills = this.deps.listSkills()
    const corpus = this.buildList(skills)
    const self = corpus.find((c) => c.kind === target.kind && c.name === target.name)
    if (!self) return []
    const needles = needlesFor(self)
    const hits: ReferenceHit[] = []
    for (const item of corpus) {
      if (item.kind === target.kind && item.name === target.name) continue
      const raw = this.body(item.kind, item.name, skills)
      if (raw === null) continue
      for (const m of findMentions(raw, needles)) {
        hits.push({ kind: item.kind, name: item.name, line: m.line, text: m.text })
      }
    }
    // Skills first: a skill citing a reference is the interesting direction, and `INDEX.md`
    // links every reference, so an alphabetical sort would bury the skills under it.
    return hits.sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === 'skill' ? -1 : 1) ||
        a.name.localeCompare(b.name) ||
        a.line - b.line
    )
  }
}
