import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hivemindCloneDir, hivemindSkillsDir, hivemindStatePath } from './paths'
import { sharedReferencesDir } from './skillsDir'
import { frontmatterDescription } from './agent/skillsResolver'
import { withFrontmatter } from './frontmatter'
import { JsonFileStore } from './fileStore'
import type { HivemindItem, HivemindPayload, PushableItem } from '../../shared/hivemind'

const execFileAsync = promisify(execFile)

export type Runner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>

const defaultRun: Runner = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, args, { cwd: opts?.cwd })
  return stdout.trim()
}

const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** 'org/name' → GitHub https URL; anything else (URL, local path) is used verbatim. */
export function cloneUrl(repo: string): string {
  return GITHUB_SHORTHAND.test(repo) ? `https://github.com/${repo}.git` : repo
}

/** Pinned installs + last sync stamp — app-managed, not user-edited. */
interface HivemindStateFile {
  lastSynced: string | null
  skills: Record<string, string>
  references: Record<string, string>
}

export interface HivemindDeps {
  argusHome: string
  repo: () => string
  git?: Runner
  gh?: Runner
}

export class HivemindService {
  private store: JsonFileStore

  constructor(private deps: HivemindDeps) {
    this.store = new JsonFileStore(hivemindStatePath(deps.argusHome))
  }

  private git(args: string[], cwd?: string): Promise<string> {
    return (this.deps.git ?? defaultRun)('git', args, { cwd })
  }

  private state(): HivemindStateFile {
    const { data } = this.store.load()
    const d = (data ?? {}) as Partial<HivemindStateFile>
    return {
      lastSynced: d.lastSynced ?? null,
      skills: d.skills ?? {},
      references: d.references ?? {}
    }
  }

  private clone(): string {
    return hivemindCloneDir(this.deps.argusHome)
  }

  async payload(): Promise<HivemindPayload> {
    const repo = this.deps.repo().trim()
    const base = {
      repo,
      error: null as string | null,
      headCommit: null as string | null,
      lastSynced: this.state().lastSynced,
      items: [] as HivemindItem[],
      pushable: this.pushable()
    }
    if (!repo) return { ...base, state: 'dormant' }
    if (!fs.existsSync(path.join(this.clone(), '.git'))) return { ...base, state: 'not-cloned' }
    try {
      const headCommit = await this.git(['rev-parse', 'HEAD'], this.clone())
      return { ...base, state: 'ready', headCommit, items: await this.listItems() }
    } catch (err) {
      return { ...base, state: 'error', error: (err as Error).message }
    }
  }

  /** Clone on first run, else pull --ff-only. Never forces; conflicts surface as errors. */
  async sync(): Promise<HivemindPayload> {
    const repo = this.deps.repo().trim()
    if (!repo) return this.payload()
    try {
      if (!fs.existsSync(path.join(this.clone(), '.git'))) {
        await this.git(['clone', cloneUrl(repo), this.clone()])
      } else {
        await this.git(['pull', '--ff-only'], this.clone())
      }
      this.store.write({ ...this.state(), lastSynced: new Date().toISOString() })
      return await this.payload()
    } catch (err) {
      const p = await this.payload()
      return { ...p, state: 'error', error: (err as Error).message }
    }
  }

  private itemCommit(rel: string): Promise<string> {
    return this.git(['log', '-1', '--format=%H', '--', rel], this.clone())
  }

  private async listItems(): Promise<HivemindItem[]> {
    const state = this.state()
    const items: HivemindItem[] = []
    const skillsRoot = path.join(this.clone(), 'skills')
    if (fs.existsSync(skillsRoot)) {
      for (const ent of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!ent.isDirectory() || !fs.existsSync(path.join(skillsRoot, ent.name, 'SKILL.md')))
          continue
        const commit = await this.itemCommit(`skills/${ent.name}`)
        const installedCommit = state.skills[ent.name] ?? null
        const installed = fs.existsSync(
          path.join(hivemindSkillsDir(this.deps.argusHome), ent.name, 'SKILL.md')
        )
        items.push({
          kind: 'skill',
          name: ent.name,
          description: frontmatterDescription(path.join(skillsRoot, ent.name)),
          commit,
          installed,
          installedCommit,
          updateAvailable: installed && installedCommit !== null && installedCommit !== commit
        })
      }
    }
    const refsRoot = path.join(this.clone(), 'references')
    if (fs.existsSync(refsRoot)) {
      for (const ent of fs.readdirSync(refsRoot, { withFileTypes: true })) {
        if (!ent.isFile() || !ent.name.endsWith('.md')) continue
        const commit = await this.itemCommit(`references/${ent.name}`)
        const installedCommit = state.references[ent.name] ?? null
        const installed = fs.existsSync(
          path.join(sharedReferencesDir(this.deps.argusHome), ent.name)
        )
        items.push({
          kind: 'reference',
          name: ent.name,
          description: '',
          commit,
          installed,
          installedCommit,
          updateAvailable: installed && installedCommit !== null && installedCommit !== commit
        })
      }
    }
    return items.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Pinned copy into the tier dirs; later pulls never mutate installed copies (spec §2.3). */
  async install(kind: 'skill' | 'reference', name: string): Promise<HivemindPayload> {
    const state = this.state()
    if (kind === 'skill') {
      const src = path.join(this.clone(), 'skills', name)
      if (!fs.existsSync(path.join(src, 'SKILL.md')))
        throw new Error(`No such HiveMind skill: ${name}`)
      const dest = path.join(hivemindSkillsDir(this.deps.argusHome), name)
      fs.rmSync(dest, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.cpSync(src, dest, { recursive: true })
      state.skills[name] = await this.itemCommit(`skills/${name}`)
    } else {
      const src = path.join(this.clone(), 'references', name)
      if (!fs.existsSync(src)) throw new Error(`No such HiveMind reference: ${name}`)
      const sha = await this.itemCommit(`references/${name}`)
      const stamped = withFrontmatter(fs.readFileSync(src, 'utf8'), {
        trust_tier: 'hivemind',
        source_repo: this.deps.repo().trim(),
        source_commit: sha
      })
      const destDir = sharedReferencesDir(this.deps.argusHome)
      fs.mkdirSync(destDir, { recursive: true })
      fs.writeFileSync(path.join(destDir, name), stamped)
      state.references[name] = sha
    }
    this.store.write(state)
    return this.payload()
  }

  /** Update preview: what changed upstream since the pinned install. */
  async diff(kind: 'skill' | 'reference', name: string): Promise<string> {
    const rel = kind === 'skill' ? `skills/${name}` : `references/${name}`
    const pinned = kind === 'skill' ? this.state().skills[name] : this.state().references[name]
    if (!pinned) return ''
    return this.git(['diff', pinned, 'HEAD', '--', rel], this.clone())
  }

  pushable(): PushableItem[] {
    // body lands in Task 9; keep a stub so payload() compiles
    return []
  }
}
