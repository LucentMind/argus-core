import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hivemindCloneDir, hivemindSkillsDir, hivemindStatePath, userSkillsDir } from './paths'
import { sharedReferencesDir } from './skillsDir'
import { frontmatterDescriptionAndAuthor } from './agent/skillsResolver'
import { withFrontmatter, fmBlock, fmField, removeFrontmatterKeys } from '../../shared/frontmatter'
import {
  stampAuthorship,
  parseAuthorship,
  isSoleAuthor,
  type Identity
} from '../../shared/authorship'
import { JsonFileStore } from './fileStore'
import type {
  HivemindCheckResult,
  HivemindItem,
  HivemindPayload,
  HivemindPushResult,
  LocalDivergence,
  PushableItem,
  PushReceipt,
  PushStatus
} from '../../shared/hivemind'
import { PUSHABLE_TIERS } from '../../shared/trustTiers'

const execFileAsync = promisify(execFile)

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
) => Promise<string>

// Node's execFile defaults to a 1 MB stdout cap; exceeding it throws ENOBUFS rather than
// something that names the limit. `localDivergence`'s two `git show` calls read whole
// upstream blobs, so any reference file over 1 MB would hit this — and the pinned branch of
// its catch reports not-diverged, silently disabling the data-loss guard for exactly the
// largest files. A known trap in this codebase (see github.ts's GH_MAX_BUFFER_BYTES); set an
// explicit, generous buffer everywhere this runner shells out.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024

const defaultRun: Runner = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd: opts?.cwd,
    env: opts?.env,
    timeout: opts?.timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES
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

/**
 * The trust_tier `install()` will stamp for `name`, given the tier already on disk.
 *
 * Extracted so the update preview cannot drift from what install actually does — the two
 * disagreeing would mean warning about a change that does not happen, or staying silent about
 * one that does.
 */
export function resolvedTier(name: string, priorTier: string): string {
  return name.startsWith('confluence/')
    ? 'confluence'
    : (PUSHABLE_TIERS as readonly string[]).includes(priorTier)
      ? priorTier
      : 'hivemind'
}

/**
 * Frontmatter the APP writes into a local copy, as opposed to content its author wrote:
 * the three `install()` stamps, plus the authorship trail `claimReference` appends.
 *
 * Authorship belongs here for the same reason the stamps do. Claiming a reference restamps
 * its tier and appends the claimer as a contributor — metadata about who took ownership, not
 * an edit. Left in the comparison, that one appended line makes every claimed reference read
 * as diverged, so an update the user has no reason to fear shows a data-loss warning and an
 * "Overwrite my copy" button for a file whose text is identical to upstream's. Stripping it
 * hides nothing real: an actual edit differs in the body (or in a field like `tags:`), which
 * this keeps.
 */
/** Frontmatter keys `install()` stamps into a local copy; upstream blobs never carry them. */
const STAMP_KEYS = ['trust_tier', 'source_repo', 'source_commit'] as const

/** Written by `stampAuthorship`, never by the asset's author typing them. */
const AUTHORSHIP_KEYS = ['author', 'origin', 'contributors'] as const

const APP_MANAGED_KEYS = [...STAMP_KEYS, ...AUTHORSHIP_KEYS] as const

/**
 * Canonical form for "is my copy the same text as upstream's?".
 *
 * Drops the app-managed keys above and normalizes line endings, but keeps every other
 * frontmatter field, so a hand-added `tags:` line counts as an edit. Without the strip a
 * pristine copy never equals its own pinned blob and every update would warn.
 *
 * Removal goes through `removeFrontmatterKeys` rather than a line-prefix filter because
 * `contributors:` is a BLOCK LIST: dropping the header alone would orphan its indented items
 * into the top level, producing frontmatter no YAML parser accepts — and this function's
 * output is what `localDivergence` shows the user as a diff.
 *
 * That output reconstructs a well-formed document with both `---` fences; a half-fenced
 * document in a data-loss preview reads as corruption. Both sides are built the same way, so
 * the verdict is unaffected either way.
 */
export function normalizeForCompare(raw: string): string {
  const lf = raw.replace(/\r\n/g, '\n')
  const block = fmBlock(lf)
  if (!block) return lf.trim()
  const stripped = removeFrontmatterKeys(lf, [...APP_MANAGED_KEYS])
  const rest = fmBlock(stripped)
  if (!rest) return stripped.trim()
  const fm = rest.fm.trim()
  return fm ? `---\n${fm}\n---\n${rest.body}`.trim() : rest.body.trim()
}

/**
 * Canonical form for a single file in a content comparison.
 *
 * Both the trailing-newline trim and the CRLF collapse are load-bearing: the `Runner` seam returns
 * `stdout.trim()`, so a blob read via `git show` has lost its trailing newline that the same file
 * read from disk still has, and a checkout on Windows may hold CRLF where the blob holds LF.
 * Without this, every comparison reports "changed" and every re-share pushes an empty commit.
 */
function norm(s: string): string {
  return s.replace(/\r\n/g, '\n').trim()
}

/** Do two path→content maps describe the same tree? Key sets and values must match exactly. */
export function sameContents(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/** Bare 'x.md' or exactly 'confluence/x.md' — no traversal, no hidden files, no other subfolders. */
function validReferenceName(name: string): boolean {
  const base = name.startsWith('confluence/') ? name.slice('confluence/'.length) : name
  return base.endsWith('.md') && !/[/\\]/.test(base) && !base.startsWith('.')
}

/** `author:` from a clone-tree reference file, or null if it can't be read — mirrors
 *  `readFrontmatter`'s swallow-and-degrade behavior so a file vanishing between the
 *  `readdirSync` and this read yields `author: null` for that one item instead of
 *  aborting the whole `listItems` scan. */
function cloneReferenceAuthor(file: string): string | null {
  try {
    return parseAuthorship(fs.readFileSync(file, 'utf8')).author
  } catch {
    return null
  }
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
        // Push receipts go too: a receipt names a PR on the OLD repo, and `openPrFor`'s
        // receipt path feeds `receipt.prUrl` straight into `gh pr view` — kept across a repo
        // switch, it can resolve a real PR (or, worse, a same-named branch) on a completely
        // different repo and hand it back as `mine: true`.
        fs.rmSync(this.clone(), { recursive: true, force: true })
        this.store.write({ ...this.state(), skills: {}, references: {}, pushes: {} })
      }
      if (!fs.existsSync(path.join(this.clone(), '.git'))) {
        await this.git(['clone', cloneUrl(repo), this.clone()])
      } else {
        await this.healParkedHead(this.clone())
        await this.git(['pull', '--ff-only'], this.clone())
      }
      this.store.write({ ...this.state(), lastSynced: new Date().toISOString() })
      return await this.payload()
    } catch (err) {
      const p = await this.payload()
      return { ...p, state: 'error', error: (err as Error).message }
    }
  }

  /**
   * A clone `push` left parked on a share branch never recovers on its own: the worktree
   * rewrite never checks anything out in the clone, so nothing else in the codebase moves its
   * HEAD back. Left parked, `pull --ff-only` just advances that dead-end branch, and every
   * HEAD-relative read (headCommit, itemCommit → updateAvailable, the update-preview diff,
   * localDivergence) stays poisoned indefinitely — including the data-loss guard the whole
   * feature exists to provide.
   *
   * Scoped narrowly to the exact `argus/share-` prefix `push` generates: those branches are the
   * only ones in this app-managed clone a user would plausibly check out deliberately (to
   * inspect their own pending PR), so the prefix isn't protecting *them* — it's protecting a
   * deliberate checkout of anything else in the clone from being stomped. A detached HEAD
   * (`rev-parse --abbrev-ref HEAD` returning the literal `HEAD`) is equally poisoned and is
   * likewise left unhealed by this check, but it fails safe: `pull --ff-only` errors instead of
   * silently advancing the wrong branch, so the result is a loud error rather than corruption.
   * Only called when a clone already exists — a fresh clone has nothing to park on.
   *
   * Only called from `sync()`, which is user-initiated (the refresh button): `install()`,
   * `payload()`/`listItems()`, and the update-preview `diff()` are all HEAD-relative but never
   * heal, so a parked clone still fools the data-loss guard for any Update performed before the
   * user next clicks Sync. That window is accepted scope — it's strictly better than the old
   * behavior, which only healed on the next `push`.
   */
  private async healParkedHead(clone: string): Promise<void> {
    const head = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], clone).catch(() => '')
    if (!head.startsWith('argus/share-')) return
    const defaultBranch = (
      await this.git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], clone)
    ).replace(/^origin\//, '')
    await this.git(['checkout', defaultBranch], clone)
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
        const { description, author } = frontmatterDescriptionAndAuthor(
          path.join(skillsRoot, ent.name)
        )
        items.push({
          kind: 'skill',
          name: ent.name,
          description,
          author,
          commit,
          installed,
          installedCommit,
          localTier: null,
          shadowedByUser: fs.existsSync(
            path.join(userSkillsDir(this.deps.argusHome), ent.name, 'SKILL.md')
          ),
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
            author: cloneReferenceAuthor(path.join(dir, ent.name)),
            commit,
            installed,
            installedCommit,
            localTier: installed ? referenceTier(localPath) || null : null,
            shadowedByUser: false,
            updateAvailable: installed && installedCommit !== null && installedCommit !== commit
          })
        }
      }
    }
    return items.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Pinned copy into the tier dirs; later pulls never mutate installed copies (spec §2.3). */
  async install(
    kind: 'skill' | 'reference',
    name: string,
    opts?: { overwriteLocalEdits?: boolean }
  ): Promise<HivemindPayload> {
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
      // One file serves both roles, so an update overwrites content. Refuse unless the
      // caller has seen what it would destroy. Main re-checks independently of the
      // renderer's own check, so a stale renderer cannot smuggle the overwrite past it.
      if (!opts?.overwriteLocalEdits && (await this.localDivergence(name)).diverged)
        throw new Error(
          `Your local copy of ${path.basename(name)} differs from the version that would be installed. ` +
            `Review the difference first.`
        )
      const sha = await this.itemCommit(`references/${name}`)
      // Installs flatten: confluence/x.md lands at references/x.md, so pack
      // manifests' referenceRouting (bare filenames) keeps resolving unchanged.
      const dest = path.join(sharedReferencesDir(this.deps.argusHome), path.basename(name))
      // A pushable local copy means this machine authored/curated it — keep that
      // tier (and push rights). Hive confluence/ items are refsync-owned: always
      // stamped confluence (un-claimable, un-pushable), a deliberate takeover.
      const prior = referenceTier(dest)
      const tier = resolvedTier(name, prior)
      // Typed against STAMP_KEYS so the two can never drift apart: adding a fourth stamp here
      // without adding it there (or vice versa) is now a compile error, not a silent gap in
      // the divergence comparison normalizeForCompare relies on.
      const stamps: Record<(typeof STAMP_KEYS)[number], string> = {
        trust_tier: tier,
        source_repo: this.deps.repo().trim(),
        source_commit: sha
      }
      const stamped = withFrontmatter(fs.readFileSync(src, 'utf8'), stamps)
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

  /**
   * Unified diff of two in-memory blobs, via a throwaway worktree-less temp dir.
   *
   * `git diff --no-index` exits 1 when the files differ — the rejection still carries the
   * diff on `stdout`. Relative paths under `mine/` and `incoming/` keep the `diff --git`
   * header clean; absolute paths would render as escaped Windows paths.
   */
  private async noIndexDiff(name: string, mine: string, incoming: string): Promise<string> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-refdiff-'))
    try {
      const rel = path.basename(name)
      for (const [dir, content] of [
        ['mine', mine],
        ['incoming', incoming]
      ] as const) {
        fs.mkdirSync(path.join(base, dir), { recursive: true })
        fs.writeFileSync(path.join(base, dir, rel), content.replace(/\r\n/g, '\n'))
      }
      try {
        return await this.git(['diff', '--no-index', '--', `mine/${rel}`, `incoming/${rel}`], base)
      } catch (err) {
        return String((err as { stdout?: string }).stdout ?? '').trim()
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  }

  /**
   * Does the installed local reference carry edits that would be lost by an update?
   *
   * Unified rule: the local file diverges when it differs from every version upstream
   * knows about. When a pin exists, that means both the pinned commit (differing from it
   * means you edited since install, but not if your text is already what upstream ships —
   * the merged-PR case, where the overwrite is a content no-op) and current HEAD. When
   * there is no pin — a first install of this name — the file is checked against HEAD
   * alone, so a hand-written `references/<name>.md` that predates any HiveMind install is
   * gated too, instead of being silently destroyed by the first install.
   *
   * A file that does not exist locally is never diverged: a first install with nothing in
   * the way proceeds normally. When the check itself cannot run, the fallback is asymmetric:
   * a pinned copy came from the hive and can be re-downloaded, so a guard that failed to run
   * must not block an update that worked before it existed — not-diverged. A file with no pin
   * exists nowhere else, so the same failure instead reports diverged (with no diff to show)
   * and makes the caller acknowledge the possible loss explicitly.
   */
  async localDivergence(name: string): Promise<LocalDivergence> {
    if (!validReferenceName(name)) return { diverged: false, diff: '', tierChange: null }
    const pin = this.state().references[name]
    const file = path.join(sharedReferencesDir(this.deps.argusHome), path.basename(name))
    if (!fs.existsSync(file)) return { diverged: false, diff: '', tierChange: null }
    // Computed as soon as a real local file is in play, and carried on every return from here
    // on — independent of `diverged`, because a confluence/ twin with byte-identical content
    // still costs push rights, and that must be reported even when there is nothing to diff.
    const prior = referenceTier(file)
    const next = resolvedTier(name, prior)
    const tierChange = next === prior ? null : { from: prior, to: next }
    let local: string
    let head: string
    let pinned: string | null = null
    try {
      local = fs.readFileSync(file, 'utf8')
      head = await this.git(['show', `HEAD:references/${name}`], this.clone())
      if (pin) pinned = await this.git(['show', `${pin}:references/${name}`], this.clone())
    } catch {
      // A pinned copy came from the hive and can be re-downloaded, so a check that
      // cannot run must not block the update. A file with no pin exists nowhere
      // else — there, refuse and make the caller acknowledge the loss explicitly.
      return pin
        ? { diverged: false, diff: '', tierChange }
        : { diverged: true, diff: '', tierChange }
    }
    const mine = normalizeForCompare(local)
    const normalizedHead = normalizeForCompare(head)
    if (mine === normalizedHead) return { diverged: false, diff: '', tierChange }
    if (pinned !== null && mine === normalizeForCompare(pinned))
      return { diverged: false, diff: '', tierChange }
    // Diff the normalized forms, not the raw files: the raw local file carries the three
    // install stamps (trust_tier/source_repo/source_commit) that the raw upstream blob never
    // does, so a raw-vs-raw diff always shows them as deletions — falsely telling the user
    // they're about to lose the very authorship claim `install()` re-applies. Normalizing
    // both sides keeps the diff in lockstep with the divergence verdict above, and still
    // shows real frontmatter edits (e.g. an added `tags:` line), which normalization preserves.
    return {
      diverged: true,
      diff: await this.noIndexDiff(name, mine, normalizedHead),
      tierChange
    }
  }

  /** Reclaim ownership: restamp a hivemind-tier installed reference as user tier (pushable again). */
  async claimReference(name: string, identity: Identity | null): Promise<HivemindPayload> {
    if (!name || /[/\\]/.test(name) || name.startsWith('.') || !name.endsWith('.md'))
      throw new Error(`Invalid reference name: ${name}`)
    const file = path.join(sharedReferencesDir(this.deps.argusHome), name)
    if (referenceTier(file) !== 'hivemind')
      throw new Error(`Not an installed HiveMind reference: ${name}`)
    // origin: null — claiming makes the asset yours to edit and share, but you did not write
    // it. The claimer joins the contributors; an upstream author (or its absence) is preserved.
    const claimed = stampAuthorship(
      withFrontmatter(fs.readFileSync(file, 'utf8'), { trust_tier: 'user' }),
      { identity, origin: null, now: new Date() }
    )
    fs.writeFileSync(file, claimed)
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

  /**
   * The authenticated GitHub login, cached for the service's lifetime.
   *
   * Needed because a PR's author is a GitHub login while this machine's `Identity` is a git
   * name/email — the two are not comparable, so "is this PR mine?" cannot be answered from the
   * identity alone. A rejected lookup clears the cache rather than sticking, and is allowed to
   * propagate: `pushStatus` catches it and fails open.
   */
  private viewerLoginCache: Promise<string> | undefined
  private viewerLogin(): Promise<string> {
    this.viewerLoginCache ??= this.gh(['api', 'user', '--jq', '.login']).catch((e: unknown) => {
      this.viewerLoginCache = undefined
      throw e
    })
    return this.viewerLoginCache
  }

  /**
   * Which of `rels` (repo-relative paths, e.g. `skills/x/.DS_Store`) the hive clone's own
   * `.gitignore`/excludes would keep `git add -A` from ever staging.
   *
   * `localContents` walks every real file on disk; `refContents` only ever sees what
   * `git ls-tree` tracks. A file present locally that git would refuse to commit (a macOS
   * `.DS_Store`, an editor swap file, ...) otherwise shows up as a key in one map and not the
   * other, so `sameContents` reports `changed: true` permanently — the open-mine+unchanged
   * block can never engage for that asset, and each click stages nothing, trips the porcelain
   * guard in `push`, and shows a false "PR opened"/"PR updated" for a push that touched
   * nothing. Batched into one `check-ignore` invocation for every candidate path rather than
   * one process per file. Run against the CLONE (which has the real `.gitignore`), using the
   * same repo-relative path strings `localContents`/`refContents` key by — that mirrors where
   * `push` actually lands the file in the worktree, so patterns like a bare `.DS_Store` (no
   * path prefix, matches at any depth) apply correctly.
   *
   * `check-ignore` exits non-zero both when nothing is ignored and on a genuine failure; a
   * thrown `Error` alone can't tell those apart. Matching this service's existing fail-open
   * policy elsewhere (see `pushStatus`'s catch), any failure here is treated as "nothing
   * ignored" rather than blocking the comparison — the cost is a false `changed: true` in the
   * rare case this call itself breaks, never a false `changed: false`.
   */
  private async gitIgnoredOf(cwd: string, rels: string[]): Promise<Set<string>> {
    if (rels.length === 0) return new Set()
    try {
      // core.quotePath defaults on, which makes check-ignore print any non-ASCII path
      // C-escaped (e.g. `skills/x/résumé.md` as `"skills/x/r\303\251sum\303\251.md"`) —
      // that never matches the plain keys `rels`/the caller's maps use, so a gitignored
      // non-ASCII file would otherwise never be excluded from the comparison. Disable it
      // for just this invocation.
      const out = await this.git(['-c', 'core.quotePath=false', 'check-ignore', ...rels], cwd)
      return new Set(
        out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      )
    } catch {
      return new Set()
    }
  }

  /** repo-relative path → normalized content, read from the local user-tier copy. */
  private async localContents(
    kind: 'skill' | 'reference',
    name: string
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const src = this.pushSource(kind, name)
    if (kind === 'reference') {
      out.set(`references/${name}`, norm(fs.readFileSync(src, 'utf8')))
    } else {
      const walk = (dir: string, rel: string): void => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const child = path.join(dir, ent.name)
          const childRel = `${rel}/${ent.name}`
          if (ent.isDirectory()) walk(child, childRel)
          else if (ent.isFile()) out.set(childRel, norm(fs.readFileSync(child, 'utf8')))
        }
      }
      walk(src, `skills/${name}`)
    }
    // Compare like with like — see gitIgnoredOf's doc comment.
    const ignored = await this.gitIgnoredOf(this.clone(), [...out.keys()])
    for (const key of ignored) out.delete(key)
    return out
  }

  /**
   * Same shape as `localContents`, read out of a git ref in the clone.
   *
   * `ls-tree -r` + per-entry `show` rather than a worktree checkout: reading through refs leaves
   * the clone's HEAD untouched, which every other read in this service depends on.
   */
  private async refContents(
    kind: 'skill' | 'reference',
    name: string,
    ref: string
  ): Promise<Map<string, string>> {
    const prefix = kind === 'skill' ? `skills/${name}` : `references/${name}`
    // core.quotePath defaults on, so plain `ls-tree` C-escapes non-ASCII paths the same way
    // `check-ignore` does (see gitIgnoredOf's comment for the concrete example) — but this
    // side of the comparison is easy to miss because it's a *different* method fixed on a
    // *different* day. `localContents`'/`gitIgnoredOf`'s keys are always the plain,
    // unescaped path strings; if only one of the two `git` invocations that can produce a
    // tracked-path key disables quoting, the maps built from each side stop matching for any
    // non-ASCII filename and `sameContents` reports `changed: true` forever for that asset.
    // BOTH sides must pass `-c core.quotePath=false` — a future third read path (another
    // `ls-tree`/`ls-files`/`status` call feeding this same key space) needs it too.
    const listing = await this.git(
      ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', ref, '--', prefix],
      this.clone()
    )
    const out = new Map<string, string>()
    for (const rel of listing
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)) {
      // `show` takes `rel` as an argument rather than printing a path itself, so
      // core.quotePath (an output-formatting option) doesn't apply here — as long as `rel`
      // is already the clean, unescaped string the fixed `ls-tree` call above now produces.
      out.set(rel, norm(await this.git(['show', `${ref}:${rel}`], this.clone())))
    }
    return out
  }

  /** The share-branch prefix `push` generates for one asset — the key to finding its PR. */
  private shareBranchPrefix(kind: 'skill' | 'reference', name: string): string {
    return `argus/share-${kind}-${name.replace(/\.md$/, '')}-`
  }

  /**
   * Is `headRefName` the branch `push` generated for this exact asset?
   *
   * A bare prefix match is not enough: `push` appends nothing but `Date.now()` after the
   * prefix, but the prefix itself has no closing boundary, so an asset whose slug is a
   * hyphenated prefix of another asset's slug collides — skill `my-skill`'s prefix
   * (`argus/share-skill-my-skill-`) is also a string-prefix of `my-skill-v2`'s branch
   * (`argus/share-skill-my-skill-v2-1699999999999`). Matched loosely, that PR gets
   * attributed to the wrong asset — wrongly blocking a legitimate share, or wrongly
   * reporting a teammate's unrelated PR as this asset's own. The trailing segment `push`
   * appends is always digits-only, so requiring exactly `<prefix><digits>` closes the gap
   * without needing to escape regex metacharacters that could appear in an asset name.
   */
  private isShareBranchFor(
    kind: 'skill' | 'reference',
    name: string,
    headRefName: string
  ): boolean {
    const prefix = this.shareBranchPrefix(kind, name)
    if (!headRefName.startsWith(prefix)) return false
    return /^\d+$/.test(headRefName.slice(prefix.length))
  }

  /** The open share PR for this asset, or null. Throws if a `gh` lookup fails. */
  private async openPrFor(
    kind: 'skill' | 'reference',
    name: string,
    me: Identity | null
  ): Promise<{ prUrl: string; branch: string; mine: boolean; author: string } | null> {
    const src = this.pushSource(kind, name)
    const raw = fs.readFileSync(kind === 'skill' ? path.join(src, 'SKILL.md') : src, 'utf8')
    if (isSoleAuthor(raw, me)) {
      // Nobody else can hold a PR for this, so the receipt is the whole record — one gh call.
      const receipt = this.state().pushes[`${kind}/${name}`]
      if (!receipt) return null
      // A receipt is only trustworthy for the repo it was written under: `gh pr view <full
      // url>` is repo-agnostic and the branch-name check below can't tell repos apart either
      // (the branch derives from the asset, not the repo), so a receipt that survived a clone
      // deletion + repo switch would otherwise resolve just fine against the WRONG repo. A
      // receipt with no `repo` at all (written before this field existed) is the one case that
      // can never be verified, so it is treated the same as a mismatch — not as a match — per
      // PushReceipt's doc comment.
      if (receipt.repo !== this.deps.repo().trim()) return null
      const pr = JSON.parse(
        await this.gh(['pr', 'view', receipt.prUrl, '--json', 'state,headRefName'])
      ) as { state: string; headRefName: string }
      if (pr.state !== 'OPEN') return null
      // The receipt is not itself proof: a stale/foreign receipt (e.g. one that outlived a
      // repo switch, before that was fixed to clear pushes) could name a PR whose branch has
      // nothing to do with this asset. Validating headRefName against the same predicate
      // `push` uses to find PRs the other way makes the receipt path trustworthy — `mine:
      // true` below is only ever returned for a branch this exact asset's `push` could have
      // generated. Accepted trade-off: a manually renamed head branch now falls back to
      // `none` (a possible duplicate PR) instead of being reused — the safe direction.
      if (!this.isShareBranchFor(kind, name, pr.headRefName)) return null
      // `author: ''` is now defensible: the branch check above guarantees this receipt names
      // OUR OWN share branch for this exact asset, not merely some PR the receipt happened to
      // point at.
      return { prUrl: receipt.prUrl, branch: pr.headRefName, mine: true, author: '' }
    }
    const prs = JSON.parse(
      await this.gh([
        'pr',
        'list',
        '--repo',
        this.deps.repo().trim(),
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'url,headRefName,author'
      ])
    ) as { url: string; headRefName: string; author: { login: string } }[]
    const hit = prs.find((p) => this.isShareBranchFor(kind, name, p.headRefName))
    if (!hit) return null
    const login = await this.viewerLogin()
    return {
      prUrl: hit.url,
      branch: hit.headRefName,
      mine: hit.author.login === login,
      author: hit.author.login
    }
  }

  /**
   * Is there already an open share PR for this asset, and is it ours?
   *
   * Read-only: creates no worktree, moves no ref, writes no state. `push` re-derives this rather
   * than trusting a value passed from the renderer, the same way `install` re-checks
   * `localDivergence` — a stale renderer must not be able to smuggle a duplicate PR past the guard.
   */
  async pushStatus(
    kind: 'skill' | 'reference',
    name: string,
    me: Identity | null
  ): Promise<PushStatus> {
    if (!this.deps.repo().trim()) return { state: 'none' }
    if (!fs.existsSync(path.join(this.clone(), '.git'))) return { state: 'none' }
    if (!fs.existsSync(this.pushSource(kind, name))) return { state: 'none' }
    let pr: { prUrl: string; branch: string; mine: boolean; author: string } | null
    try {
      pr = await this.openPrFor(kind, name, me)
    } catch (err) {
      // Fail OPEN, matching localDivergence's rule: a guard that could not run must not block an
      // operation that worked before the guard existed. The cost is a recoverable duplicate PR;
      // failing closed would break sharing entirely whenever GitHub is briefly unreachable.
      // This is genuinely "could not tell whether a PR exists" — logged so a real programming
      // bug here is diagnosable from a log, not only as the UI's generic warning string.
      console.warn('[hivemind] pushStatus: failed to resolve an existing PR', err)
      return { state: 'none', warning: (err as Error).message }
    }
    if (!pr) return { state: 'none' }
    if (!pr.mine) return { state: 'open-teammate', prUrl: pr.prUrl, prAuthor: pr.author }
    try {
      await this.git(['fetch', 'origin'], this.clone())
      const changed = !sameContents(
        await this.localContents(kind, name),
        await this.refContents(kind, name, `origin/${pr.branch}`)
      )
      return { state: 'open-mine', prUrl: pr.prUrl, changed }
    } catch (err) {
      // Unlike the catch above, we already KNOW an open PR of ours exists — `pr` is resolved
      // and `pr.mine` is true. Only the changed-comparison failed (a flaky `git fetch`, an
      // unreadable ref blob), so failing open here must not un-know that PR: report it as
      // conservatively CHANGED so the reuse path in `push` runs — and fails loudly there if
      // the same problem persists — rather than silently opening a duplicate PR for an asset
      // that already has one.
      console.warn('[hivemind] pushStatus: PR confirmed but the change comparison failed', err)
      return { state: 'open-mine', prUrl: pr.prUrl, changed: true }
    }
  }

  /** The commit an installed item is pinned to, or null when it was authored locally.
   *  `|| null`, not `?? null` — an empty-string pin (falsy but not nullish) must also fall
   *  back to origin/HEAD at the call site, or `push` runs `git worktree add -b <branch> <tree> ''`. */
  private pinFor(kind: 'skill' | 'reference', name: string): string | null {
    const state = this.state()
    return (kind === 'skill' ? state.skills[name] : state.references[name]) || null
  }

  /** Content preview for the confirm dialog. */
  pushPreview(kind: 'skill' | 'reference', name: string): string {
    const src = this.pushSource(kind, name)
    const file = kind === 'skill' ? path.join(src, 'SKILL.md') : src
    return fs.readFileSync(file, 'utf8')
  }

  /**
   * Share one user-tier asset to the hive.
   *
   * Three outcomes, decided by `pushStatus` (re-derived here, never taken from the caller):
   * an open PR of ours with no local change is returned as-is (no git, no gh); an open PR of ours
   * with local changes gets a new commit on its own branch; anything else cuts a fresh branch and
   * opens a new PR. A PR someone else opened is refused outright — pushing onto a teammate's branch
   * is not ours to do, and there is deliberately no override.
   *
   * Never force-pushes (spec §2.3).
   */
  async push(
    kind: 'skill' | 'reference',
    name: string,
    title: string,
    me: Identity | null
  ): Promise<HivemindPushResult> {
    const repo = this.deps.repo().trim()
    if (!repo) return { ok: false, error: 'No HiveMind repo configured (Settings → Team).' }
    const clone = this.clone()
    if (!fs.existsSync(path.join(clone, '.git')))
      return { ok: false, error: 'HiveMind clone missing — Sync first.' }
    const src = this.pushSource(kind, name)
    if (!fs.existsSync(src)) return { ok: false, error: `Not found in the user tier: ${name}` }

    const status = await this.pushStatus(kind, name, me)
    if (status.state === 'open-teammate') {
      return {
        ok: false,
        error: `${status.prAuthor} already has an open pull request for ${name}. Sharing again would duplicate it.`,
        blockedByPrUrl: status.prUrl,
        blockedByAuthor: status.prAuthor
      }
    }
    // Unchanged and already open: the block IS returning the existing PR without pushing.
    if (status.state === 'open-mine' && !status.changed)
      return { ok: true, prUrl: status.prUrl, outcome: 'unchanged' }

    const reusing = status.state === 'open-mine'
    let tree: string | null = null
    let branch = `argus/share-${kind}-${name.replace(/\.md$/, '')}-${Date.now()}`
    // Set together with `branch`, from the same lookup, when reusing — see `reopenPrFor`'s
    // doc comment for why. Never read `status.prUrl` below this point.
    let reusedPrUrl = ''
    try {
      await this.git(['fetch', 'origin'], clone)
      // Heal a stale registration left by a previous failed removal, so a single bad cleanup
      // cannot block every later push.
      await this.git(['worktree', 'prune'], clone)
      const defaultBranch = (
        await this.git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], clone)
      ).replace(/^origin\//, '')
      // Re-check ownership on a lookup fresher than pushStatus's, BEFORE any worktree exists.
      // `fetch`/`worktree prune`/`rev-parse` above all take real wall-clock time, and in that
      // window a teammate can open a competing share for the same asset (exactly the duplicate
      // this feature exists to prevent) — see `reopenPrFor`'s doc comment. Resolving this here,
      // ahead of `mkdtempSync`, means a refusal creates no worktree and leaves nothing for the
      // `finally` block to clean up.
      let reused: { prUrl: string; branch: string } | null = null
      if (reusing) {
        const pr = await this.reopenPrFor(kind, name, me)
        if (!pr.mine) {
          return {
            ok: false,
            error: `${pr.author} already has an open pull request for ${name}. Sharing again would duplicate it.`,
            blockedByPrUrl: pr.prUrl,
            blockedByAuthor: pr.author
          }
        }
        reused = { prUrl: pr.prUrl, branch: pr.branch }
      }
      // Branch from the PIN when this item came from HiveMind. Cutting from origin/HEAD would
      // make the whole-dir replace below undo every upstream change since the install — the PR
      // would silently revert pin→HEAD on top of the intended edit. From the pin, the diff is
      // exactly the local edits and GitHub surfaces any conflict upstream, where the reviewer
      // has the context to resolve it.
      const base = this.pinFor(kind, name) ?? `origin/${defaultBranch}`
      // A separate worktree, never a checkout in the clone. Every upstream read — headCommit,
      // itemCommit (so updateAvailable), diff, and localDivergence — is relative to the clone's
      // HEAD. Moving it and failing to move it back makes the divergence guard compare a local
      // file against the user's own pushed content, report not-diverged, and overwrite edits
      // made since the push. Not moving it at all makes that unreachable.
      //
      // The path must not already exist: older git refuses to populate an existing directory,
      // so create a temp parent and hand git a child path inside it.
      const treeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-share-'))
      tree = path.join(treeParent, 'wt')
      if (reusing) {
        // `-B` resets the LOCAL branch in this app-managed clone to the remote tip and checks it
        // out. It is not a force-push: the subsequent `push origin <branch>` still fast-forwards,
        // so a teammate's commit landing between the fetch and the push is rejected, not stomped.
        branch = reused!.branch
        reusedPrUrl = reused!.prUrl
        await this.git(['worktree', 'add', '-B', branch, tree, `origin/${branch}`], clone)
      } else {
        await this.git(['worktree', 'add', '-b', branch, tree, base], clone)
      }
      const dest = path.join(tree, kind === 'skill' ? 'skills' : 'references', name)
      if (kind === 'skill') {
        fs.rmSync(dest, { recursive: true, force: true })
        fs.cpSync(src, dest, { recursive: true })
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
      }
      await this.git(['add', '-A'], tree)
      if (reusing && !(await this.git(['status', '--porcelain'], tree)).trim()) {
        // pushStatus said changed, the worktree says otherwise — trust the worktree and do not
        // attempt an empty commit, which git rejects. Nothing was pushed, so this is the same
        // "already there" outcome as the early-return above, not a fresh update.
        return { ok: true, prUrl: reusedPrUrl, outcome: 'unchanged' }
      }
      await this.git(['commit', '-m', `share ${kind}: ${name} (via Argus)`], tree)
      let prUrl: string
      if (reusing) {
        await this.git(['push', 'origin', branch], tree)
        prUrl = reusedPrUrl
      } else {
        await this.git(['push', '-u', 'origin', branch], tree)
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
        prUrl = out.split(/\s+/).find((t) => t.startsWith('https://')) ?? out
      }
      const state = this.state()
      state.pushes[`${kind}/${name}`] = { prUrl, pushedAt: new Date().toISOString(), repo }
      this.store.write(state)
      return { ok: true, prUrl, outcome: reusing ? 'updated' : 'created' }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      if (tree) {
        // Best-effort cleanup only: nothing here may throw, or it overrides whatever the
        // try/catch above already decided — a completed `{ ok: true, prUrl }` (the PR exists
        // and the receipt is written; a cleanup error here must not turn that into a reported
        // failure) or a real `{ ok: false, error }` (a cleanup error here must not replace the
        // actual diagnostic). If `worktree remove` fails, only the `.git/worktrees`
        // registration leaks — the next push's `worktree prune` heals it. If the temp-dir
        // removal below also fails (e.g. EBUSY/EPERM from an AV or indexer still holding a
        // handle on Windows, right after git released it), the temp directory itself leaks
        // until the OS reclaims temp space. Either way the cost is disk, never the result.
        try {
          await this.git(['worktree', 'remove', '--force', tree], clone)
        } catch {
          // See comment above: intentionally swallowed.
        }
        try {
          fs.rmSync(path.dirname(tree), {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100
          })
        } catch {
          // See comment above: intentionally swallowed.
        }
      }
    }
  }

  /**
   * Re-resolve the open PR to reuse, as one lookup that yields `branch`, `prUrl`, and — the
   * caller MUST check this — fresh ownership (`mine`/`author`).
   *
   * `push` used to take `branch` from a lookup here and `prUrl` from `pushStatus`'s *earlier*
   * lookup (made before `fetch`/`worktree prune`/`rev-parse`), trusting both had found the same
   * PR. For a sole-authored asset they always do — both are anchored to the same immutable
   * receipt. But for a non-sole-authored asset each lookup independently re-runs `gh pr list`,
   * and if a duplicate share PR exists for the asset (e.g. from pushes made before this feature
   * existed) the two calls can resolve to *different* PRs when GitHub's answer changes between
   * them. `push` would then commit and push to one PR's branch while reporting — and writing
   * into the receipt — the other PR's url, silently pointing the user at a PR that does not hold
   * their commit. Returning the whole record here and using *only* this record's `prUrl` (never
   * `status.prUrl`) makes that divergence structurally impossible: branch and prUrl always name
   * the same PR because they come from the same `gh` answer.
   *
   * The same elapsed time is also long enough for ownership itself to change: a teammate can
   * open a competing share for this exact asset in that window — the duplicate this feature
   * exists to prevent — and this fresher lookup then resolves to *their* PR instead of ours. An
   * earlier version of this helper discarded `mine`/`author` from `openPrFor`'s result and
   * returned a bare `{ prUrl, branch }`, so `push` had no way to notice and went on to
   * `worktree add -B` their branch, commit, and push onto it — silently overriding the one rule
   * this feature is built around: a PR someone else owns is never pushed to, no exceptions. The
   * full record is returned here, and the caller checks `mine` before touching the worktree, so
   * that check cannot be silently dropped again.
   *
   * Only called when `pushStatus` said `open-mine`. Still throws if the PR has disappeared
   * mid-push (closed/merged between the two fetches) — that failure is correct and safe.
   */
  private async reopenPrFor(
    kind: 'skill' | 'reference',
    name: string,
    me: Identity | null
  ): Promise<{ prUrl: string; branch: string; mine: boolean; author: string }> {
    const pr = await this.openPrFor(kind, name, me)
    if (!pr) throw new Error(`The open pull request for ${name} disappeared mid-push.`)
    return pr
  }
}
