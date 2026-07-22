import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hivemindCloneDir, hivemindSkillsDir, hivemindStatePath, userSkillsDir } from './paths'
import { sharedReferencesDir } from './skillsDir'
import { frontmatterDescription } from './agent/skillsResolver'
import { withFrontmatter, fmBlock, fmField } from './frontmatter'
import { JsonFileStore } from './fileStore'
import type {
  HivemindCheckResult,
  HivemindItem,
  HivemindPayload,
  HivemindPushResult,
  PushableItem,
  PushReceipt
} from '../../shared/hivemind'
import { PUSHABLE_TIERS } from '../../shared/trustTiers'

const execFileAsync = promisify(execFile)

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
) => Promise<string>

const defaultRun: Runner = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd: opts?.cwd,
    env: opts?.env,
    timeout: opts?.timeoutMs
  })
  return stdout.trim()
}

const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** 'org/name' → GitHub https URL; anything else (URL, local path) is used verbatim. */
export function cloneUrl(repo: string): string {
  return GITHUB_SHORTHAND.test(repo) ? `https://github.com/${repo}.git` : repo
}

/** trust_tier of a local reference file; '' when the file is absent or tier-less. */
function referenceTier(file: string): string {
  if (!fs.existsSync(file)) return ''
  const block = fmBlock(fs.readFileSync(file, 'utf8'))
  return block ? fmField(block.fm, 'trust_tier') : ''
}

/** Bare 'x.md' or exactly 'confluence/x.md' — no traversal, no hidden files, no other subfolders. */
function validReferenceName(name: string): boolean {
  const base = name.startsWith('confluence/') ? name.slice('confluence/'.length) : name
  return base.endsWith('.md') && !/[/\\]/.test(base) && !base.startsWith('.')
}

/** Pinned installs + last sync stamp + push receipts — app-managed, not user-edited. */
interface HivemindStateFile {
  lastSynced: string | null
  skills: Record<string, string>
  references: Record<string, string>
  pushes: Record<string, PushReceipt>
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

  private git(
    args: string[],
    cwd?: string,
    opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }
  ): Promise<string> {
    return (this.deps.git ?? defaultRun)('git', args, { cwd, ...opts })
  }

  private gh(args: string[], cwd?: string): Promise<string> {
    return (this.deps.gh ?? defaultRun)('gh', args, { cwd })
  }

  private state(): HivemindStateFile {
    const { data } = this.store.load()
    const d = (data ?? {}) as Partial<HivemindStateFile>
    return {
      lastSynced: d.lastSynced ?? null,
      skills: d.skills ?? {},
      references: d.references ?? {},
      pushes: d.pushes ?? {}
    }
  }

  private clone(): string {
    return hivemindCloneDir(this.deps.argusHome)
  }

  /**
   * True when the on-disk clone's origin positively differs from the configured
   * repo (i.e. the setting changed after cloning). Unknown/unreadable origins
   * count as matching so a git hiccup can never wipe a healthy clone.
   */
  private async cloneIsStale(repo: string): Promise<boolean> {
    if (!fs.existsSync(path.join(this.clone(), '.git'))) return false
    let origin: string
    try {
      origin = (await this.git(['remote', 'get-url', 'origin'], this.clone())).trim()
    } catch {
      return false
    }
    return origin !== '' && origin !== cloneUrl(repo)
  }

  async payload(): Promise<HivemindPayload> {
    const repo = this.deps.repo().trim()
    const st = this.state()
    const base = {
      repo,
      error: null as string | null,
      headCommit: null as string | null,
      lastSynced: st.lastSynced,
      items: [] as HivemindItem[],
      pushable: this.pushable(),
      pushes: st.pushes
    }
    if (!repo) return { ...base, state: 'dormant' }
    if (!fs.existsSync(path.join(this.clone(), '.git'))) return { ...base, state: 'not-cloned' }
    // A clone of a previously-configured repo is not this repo's content —
    // report not-cloned (sync will replace it) rather than listing stale items.
    if (await this.cloneIsStale(repo)) return { ...base, state: 'not-cloned' }
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
      if (await this.cloneIsStale(repo)) {
        // Repo setting changed: replace the clone and drop the old repo's pins.
        // Installed copies stay — they are pinned snapshots by design (spec §2.3).
        fs.rmSync(this.clone(), { recursive: true, force: true })
        this.store.write({ ...this.state(), skills: {}, references: {} })
      }
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

  /** Cheap reachability probe for instant settings feedback — no clone, no state change. */
  async check(): Promise<HivemindCheckResult> {
    const repo = this.deps.repo().trim()
    if (!repo) return { ok: false, error: 'No HiveMind repo configured.' }
    try {
      await this.git(['ls-remote', cloneUrl(repo), 'HEAD'], undefined, {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        timeoutMs: 15000
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
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
          localTier: null,
          updateAvailable: installed && installedCommit !== null && installedCommit !== commit
        })
      }
    }
    const refsRoot = path.join(this.clone(), 'references')
    if (fs.existsSync(refsRoot)) {
      // Flat files plus the one specifically-named confluence/ subfolder —
      // deliberately not a generic recursion (spec: subfolder-references design).
      for (const subdir of ['', 'confluence']) {
        const dir = subdir ? path.join(refsRoot, subdir) : refsRoot
        if (!fs.existsSync(dir)) continue
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!ent.isFile() || !ent.name.endsWith('.md') || ent.name.startsWith('.')) continue
          const name = subdir ? `${subdir}/${ent.name}` : ent.name
          const commit = await this.itemCommit(`references/${name}`)
          const installedCommit = state.references[name] ?? null
          // Installs flatten: the local copy always lives at the bare basename.
          const localPath = path.join(sharedReferencesDir(this.deps.argusHome), ent.name)
          const installed = fs.existsSync(localPath)
          items.push({
            kind: 'reference',
            name,
            description: '',
            commit,
            installed,
            installedCommit,
            localTier: installed ? referenceTier(localPath) || null : null,
            updateAvailable: installed && installedCommit !== null && installedCommit !== commit
          })
        }
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
      if (!validReferenceName(name)) throw new Error(`Invalid reference name: ${name}`)
      const src = path.join(this.clone(), 'references', name)
      if (!fs.existsSync(src)) throw new Error(`No such HiveMind reference: ${name}`)
      const sha = await this.itemCommit(`references/${name}`)
      // Installs flatten: confluence/x.md lands at references/x.md, so pack
      // manifests' referenceRouting (bare filenames) keeps resolving unchanged.
      const dest = path.join(sharedReferencesDir(this.deps.argusHome), path.basename(name))
      // A pushable local copy means this machine authored/curated it — keep that
      // tier (and push rights). Hive confluence/ items are refsync-owned: always
      // stamped confluence (un-claimable, un-pushable), a deliberate takeover.
      const prior = referenceTier(dest)
      const tier = name.startsWith('confluence/')
        ? 'confluence'
        : (PUSHABLE_TIERS as readonly string[]).includes(prior)
          ? prior
          : 'hivemind'
      const stamped = withFrontmatter(fs.readFileSync(src, 'utf8'), {
        trust_tier: tier,
        source_repo: this.deps.repo().trim(),
        source_commit: sha
      })
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, stamped)
      state.references[name] = sha
    }
    this.store.write(state)
    return this.payload()
  }

  /** Delete the installed copy and its pin; the item reverts to installable in Browse. */
  async uninstallSkill(name: string): Promise<HivemindPayload> {
    if (!name || /[/\\]/.test(name) || name.startsWith('.'))
      throw new Error(`Invalid skill name: ${name}`)
    const dest = path.join(hivemindSkillsDir(this.deps.argusHome), name)
    if (!fs.existsSync(path.join(dest, 'SKILL.md')))
      throw new Error(`Not an installed HiveMind skill: ${name}`)
    fs.rmSync(dest, { recursive: true, force: true })
    const state = this.state()
    delete state.skills[name]
    this.store.write(state)
    return this.payload()
  }

  /**
   * Delete the installed local copy and its pin. Only hive-managed tiers
   * (hivemind/confluence) qualify — user/team-knowledge copies are the user's
   * own content and stay untouched (mirror of the claimReference guard).
   */
  async uninstallReference(name: string): Promise<HivemindPayload> {
    if (!validReferenceName(name)) throw new Error(`Invalid reference name: ${name}`)
    const file = path.join(sharedReferencesDir(this.deps.argusHome), path.basename(name))
    const tier = referenceTier(file)
    if (tier !== 'hivemind' && tier !== 'confluence')
      throw new Error(`Not an installed HiveMind reference: ${name}`)
    fs.rmSync(file, { force: true })
    const state = this.state()
    delete state.references[name]
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

  /** Reclaim authorship: restamp a hivemind-tier installed reference as user tier (pushable again). */
  async claimReference(name: string): Promise<HivemindPayload> {
    if (!name || /[/\\]/.test(name) || name.startsWith('.') || !name.endsWith('.md'))
      throw new Error(`Invalid reference name: ${name}`)
    const file = path.join(sharedReferencesDir(this.deps.argusHome), name)
    if (referenceTier(file) !== 'hivemind')
      throw new Error(`Not an installed HiveMind reference: ${name}`)
    fs.writeFileSync(file, withFrontmatter(fs.readFileSync(file, 'utf8'), { trust_tier: 'user' }))
    return this.payload()
  }

  /** User-tier assets eligible for sharing: skills-user/* + curated references. */
  pushable(): PushableItem[] {
    const out: PushableItem[] = []
    const uroot = userSkillsDir(this.deps.argusHome)
    if (fs.existsSync(uroot)) {
      for (const ent of fs.readdirSync(uroot, { withFileTypes: true })) {
        if (ent.isDirectory() && fs.existsSync(path.join(uroot, ent.name, 'SKILL.md')))
          out.push({ kind: 'skill', name: ent.name })
      }
    }
    const rroot = sharedReferencesDir(this.deps.argusHome)
    if (fs.existsSync(rroot)) {
      for (const ent of fs.readdirSync(rroot, { withFileTypes: true })) {
        if (!ent.isFile() || !ent.name.endsWith('.md')) continue
        const block = fmBlock(fs.readFileSync(path.join(rroot, ent.name), 'utf8'))
        const tier = block ? fmField(block.fm, 'trust_tier') : ''
        if ((PUSHABLE_TIERS as readonly string[]).includes(tier))
          out.push({ kind: 'reference', name: ent.name })
      }
    }
    return out
  }

  private pushSource(kind: 'skill' | 'reference', name: string): string {
    return kind === 'skill'
      ? path.join(userSkillsDir(this.deps.argusHome), name)
      : path.join(sharedReferencesDir(this.deps.argusHome), name)
  }

  /** Content preview for the confirm dialog. */
  pushPreview(kind: 'skill' | 'reference', name: string): string {
    const src = this.pushSource(kind, name)
    const file = kind === 'skill' ? path.join(src, 'SKILL.md') : src
    return fs.readFileSync(file, 'utf8')
  }

  /** Branch in the clone → commit → push → gh pr create. Never force-pushes (spec §2.3). */
  async push(
    kind: 'skill' | 'reference',
    name: string,
    title: string
  ): Promise<HivemindPushResult> {
    const repo = this.deps.repo().trim()
    if (!repo) return { ok: false, error: 'No HiveMind repo configured (Settings → Team).' }
    const clone = this.clone()
    if (!fs.existsSync(path.join(clone, '.git')))
      return { ok: false, error: 'HiveMind clone missing — Sync first.' }
    const src = this.pushSource(kind, name)
    if (!fs.existsSync(src)) return { ok: false, error: `Not found in the user tier: ${name}` }
    const branch = `argus/share-${kind}-${name.replace(/\.md$/, '')}-${Date.now()}`
    let defaultBranch = 'main'
    try {
      await this.git(['fetch', 'origin'], clone)
      defaultBranch = (await this.git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], clone)).replace(
        /^origin\//,
        ''
      )
      await this.git(['checkout', '-B', branch, `origin/${defaultBranch}`], clone)
      const dest = path.join(clone, kind === 'skill' ? 'skills' : 'references', name)
      if (kind === 'skill') {
        fs.rmSync(dest, { recursive: true, force: true })
        fs.cpSync(src, dest, { recursive: true })
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
      }
      await this.git(['add', '-A'], clone)
      await this.git(['commit', '-m', `share ${kind}: ${name} (via Argus)`], clone)
      await this.git(['push', '-u', 'origin', branch], clone)
      const out = await this.gh(
        [
          'pr',
          'create',
          '--title',
          title,
          '--body',
          `Shared from Argus (${kind}: ${name}).`,
          '--head',
          branch
        ],
        clone
      )
      const prUrl = out.split(/\s+/).find((t) => t.startsWith('https://')) ?? out
      const state = this.state()
      state.pushes[`${kind}/${name}`] = { prUrl, pushedAt: new Date().toISOString() }
      this.store.write(state)
      return { ok: true, prUrl }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      try {
        await this.git(['checkout', defaultBranch], clone)
      } catch {
        // leave the clone as-is; the next sync/payload reports its state
      }
    }
  }
}
