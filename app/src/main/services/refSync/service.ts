import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sharedReferencesDir } from '../skillsDir'
import { contentHash } from '../contentHash'
import { validateReference, hasErrors } from '../../../shared/assetValidation'
import { withFrontmatter } from '../../../shared/frontmatter'
import { mergeAuthorship, stampAuthorship, type Identity } from '../../../shared/authorship'
import { ReferenceSyncStore, readSyncState, writeSyncState } from '../referenceSyncStore'
import {
  walkSelection,
  computeChangedSet,
  referenceStatuses,
  generateReferencesIndex,
  detectVanished,
  type ConfluenceReader
} from './engine'
import { distillTarget } from './distill'
import {
  refBody,
  refTier,
  refTitle,
  parseRefSources,
  stampRefFile,
  assertHandOwnedReferenceTier,
  type RefSource
} from './refFrontmatter'
import {
  isStale,
  isOutdated,
  emptySpaceState,
  missingMustKeep,
  REFERENCES_INDEX,
  REF_TARGET_RE,
  type RefSyncPayload,
  type SyncReport,
  type DraftFile,
  type TreeNodeVM
} from '../../../shared/referenceSync'
import type {
  ConfluenceSpace,
  ConfluencePageNode,
  ConfluencePageContent
} from '../../../shared/confluence'

export interface RefSyncServiceDeps {
  argusHome: string
  store: ReferenceSyncStore
  reader: ConfluenceReader
  /** Headless one-shot runner; resolves its own provider. Injectable for tests. */
  run?: (prompt: string) => Promise<string>
  /** Injectable for tests; defaults to the headless distiller. */
  distill?: typeof distillTarget
  /** Prompt-registry resolver, forwarded to the distiller. */
  resolvePrompt?: (id: string) => string
  now?: () => Date
}

export class RefSyncService {
  private pendingDrafts = new Map<string, SyncReport>()

  constructor(private deps: RefSyncServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private refsDir(): string {
    return sharedReferencesDir(this.deps.argusHome)
  }

  payload(): RefSyncPayload {
    const config = this.deps.store.get()
    const state = readSyncState(this.deps.argusHome)
    const now = this.now()
    return {
      config,
      loadError: this.deps.store.loadError(),
      cards: config.spaces.map((s) => {
        const st = state.spaces[s.key] ?? emptySpaceState()
        return {
          key: s.key,
          name: s.name || s.key,
          pageCount: Object.keys(st.seenPages).length || null,
          lastSyncedAt: st.lastSyncedAt,
          stale: isStale(st.lastSyncedAt, now) || st.driftTargets.length > 0,
          driftTargets: st.driftTargets
        }
      }),
      references: referenceStatuses(this.refsDir(), now)
    }
  }

  async validateSpace(key: string): Promise<{ space: ConfluenceSpace; root: TreeNodeVM }> {
    const space = await this.deps.reader.getConfluenceSpace(key)
    if (!space.homepageId) throw new Error(`Space ${key} has no homepage`)
    const root = await this.deps.reader.getConfluencePage(space.homepageId)
    return { space, root: this.decorateAll(space.key, [root])[0] }
  }

  async children(spaceKey: string, pageId: string): Promise<TreeNodeVM[]> {
    return this.decorateAll(spaceKey, await this.deps.reader.getConfluenceChildren(pageId))
  }

  private decorateAll(spaceKey: string, nodes: ConfluencePageNode[]): TreeNodeVM[] {
    const st = readSyncState(this.deps.argusHome).spaces[spaceKey]
    const windowMonths = this.deps.store.get().outdatedWindowMonths
    const now = this.now()
    return nodes.map((n) => ({
      ...n,
      isNew: !!st?.lastSyncedAt && !st.seenPages[n.id],
      outdated: isOutdated(n.lastModified, windowMonths, now)
    }))
  }

  saveSpace(space: unknown): void {
    this.deps.store.upsertSpace(space)
  }

  removeSpace(key: string): void {
    this.deps.store.removeSpace(key)
    const state = readSyncState(this.deps.argusHome)
    if (state.spaces[key]) {
      delete state.spaces[key]
      writeSyncState(this.deps.argusHome, state)
    }
  }

  /** Read one reference file for the in-app viewer/editor (name guarded like applyDrafts). */
  readReference(file: string): { file: string; content: string; hash: string } {
    if (!REF_TARGET_RE.test(file)) throw new Error(`invalid reference name: ${file}`)
    const content = fs.readFileSync(path.join(this.refsDir(), file), 'utf8')
    return { file, content, hash: contentHash(content) }
  }

  /**
   * Permanently delete a hand-owned reference (user/team-knowledge/untagged).
   * Hive-managed tiers must go through hivemind.uninstallReference — mirror
   * image of its guard, which refuses hand-owned tiers.
   */
  deleteReference(file: string): void {
    if (!REF_TARGET_RE.test(file) || file === REFERENCES_INDEX) {
      throw new Error(`invalid reference name: ${file}`)
    }
    const p = path.join(this.refsDir(), file)
    const tier = refTier(fs.readFileSync(p, 'utf8')) ?? 'team-knowledge'
    assertHandOwnedReferenceTier(tier, file)
    fs.rmSync(p, { force: true })
  }

  /**
   * Write a hand-owned reference (user/team-knowledge/untagged). Mirror image of
   * `deleteReference`'s guard: hive-managed tiers must be claimed first, so a stale renderer
   * cannot smuggle an edit past the fork step.
   *
   * An untagged file is stamped `trust_tier: user` on save — you just authored it, and without
   * a stamp `hivemind.pushable()` would never offer it for sharing. An existing stamp is kept.
   *
   * `identity` (null when this machine has no git identity) is stamped in as authorship too:
   * the saver joins `contributors`, and authors the file if nobody has yet. Authorship, like
   * `trust_tier`, is read back off the existing file and overrules whatever `content` claims.
   *
   * Returns the hash of the bytes actually written (post-stamp), not of `content` as received —
   * the caller must adopt this as its next `baseHash`, or its own stamping write would make its
   * next save fail with a misleading "changed on disk" conflict.
   */
  writeReference(
    file: string,
    content: string,
    baseHash: string | null,
    identity: Identity | null
  ): string {
    const issues = validateReference({ file, content })
    if (hasErrors(issues)) throw new Error(issues.find((i) => i.severity === 'error')!.message)

    const p = path.join(this.refsDir(), file)
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
    const tier = existing === null ? null : refTier(existing)
    assertHandOwnedReferenceTier(tier, file)
    if ((existing === null ? null : contentHash(existing)) !== baseHash) {
      // baseHash null means the editor believes it is CREATING "file" — if a file is already
      // there, that's a name collision, not a concurrent edit of something the editor had open.
      if (baseHash === null && existing !== null) {
        throw new Error(`"${file}" already exists — choose a different name.`)
      }
      throw new Error(`"${file}" changed on disk since you opened it.`)
    }
    fs.mkdirSync(this.refsDir(), { recursive: true })
    // mergeAuthorship for the same reason `tier` is re-read above: the file on disk is the
    // authority for author/origin/contributors, `content` is not. A buffer that lost the
    // `author:` line — Improve's model round-trip, or a hand edit — would otherwise hand the
    // byline to whoever saved next and drop everyone before them off the trail.
    const written = stampAuthorship(
      mergeAuthorship(withFrontmatter(content, { trust_tier: tier ?? 'user' }), existing),
      {
        identity,
        origin: 'authored',
        now: this.deps.now?.() ?? new Date()
      }
    )
    fs.writeFileSync(p, written)
    return contentHash(written)
  }

  /** Case-insensitive search over reference file names AND bodies; INDEX.md excluded. */
  searchReferences(query: string): string[] {
    const q = query.trim().toLowerCase()
    if (!q || !fs.existsSync(this.refsDir())) return []
    return fs
      .readdirSync(this.refsDir(), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== REFERENCES_INDEX)
      .filter((e) => {
        if (e.name.toLowerCase().includes(q)) return true
        try {
          return fs
            .readFileSync(path.join(this.refsDir(), e.name), 'utf8')
            .toLowerCase()
            .includes(q)
        } catch {
          return false
        }
      })
      .map((e) => e.name)
  }

  /** Deterministic walk + per-target headless distillation. Never writes reference files. */
  async sync(spaceKey: string, onProgress?: (message: string) => void): Promise<SyncReport> {
    const config = this.deps.store.get()
    const space = config.spaces.find((s) => s.key === spaceKey)
    if (!space) throw new Error(`No such space: ${spaceKey}`)
    const selected = await walkSelection(this.deps.reader, space, onProgress)
    const { changed, unrouted, conflicts } = computeChangedSet(selected, space, this.refsDir())
    const drafts: DraftFile[] = []
    const failures: Array<{ target: string; error: string }> = []
    const distill = this.deps.distill ?? distillTarget
    for (const { target, pages } of changed) {
      try {
        onProgress?.(`fetching ${pages.length} page(s) for ${target}…`)
        const contents: ConfluencePageContent[] = []
        for (const p of pages) contents.push(await this.deps.reader.getConfluencePageContent(p.id))
        const file = path.join(this.refsDir(), target)
        const oldRaw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
        onProgress?.(`distilling ${target}…`)
        const newBody = await distill(
          {
            target,
            currentBody: oldRaw ? refBody(oldRaw) : null,
            pages: contents.map((c) => ({
              title: c.node.title,
              url: c.url,
              markdown: c.markdown,
              pageId: c.node.id,
              version: c.node.version
            }))
          },
          this.deps.run ??
            (() => {
              throw new Error('no provider configured for distillation')
            }),
          this.deps.resolvePrompt
        )
        drafts.push({
          target,
          oldBody: oldRaw ? refBody(oldRaw) : null,
          newBody,
          guardMisses: missingMustKeep(newBody, config.mustKeep[target] ?? []),
          pages: contents.map((c) => ({
            id: c.node.id,
            title: c.node.title,
            url: c.url,
            version: c.node.version
          }))
        })
      } catch (err) {
        failures.push({ target, error: (err as Error).message })
      }
    }
    // record the sync run: NEW badges + "known drift" staleness (spec §3.2/§3.4)
    const state = readSyncState(this.deps.argusHome)
    // Read the PREVIOUS snapshot before overwriting it — it is the only record of what the
    // space used to contain, and therefore the only way to notice an upstream deletion.
    const previousSeen = state.spaces[spaceKey]?.seenPages ?? {}
    const vanished = detectVanished(
      this.refsDir(),
      previousSeen,
      new Set(selected.map((p) => p.id))
    )
    state.spaces[spaceKey] = {
      lastSyncedAt: this.now().toISOString(),
      seenPages: Object.fromEntries(
        selected.map((p) => [
          p.id,
          { version: p.version, lastModified: p.lastModified, title: p.title }
        ])
      ),
      driftTargets: changed.map((c) => c.target)
    }
    writeSyncState(this.deps.argusHome, state)
    const report: SyncReport = {
      syncId: crypto.randomUUID(),
      spaceKey,
      selectedCount: selected.length,
      drafts,
      unrouted: unrouted.map((p) => ({ id: p.id, title: p.title })),
      conflicts,
      failures,
      vanished
    }
    this.pendingDrafts.set(report.syncId, report)
    return report
  }

  /** The ONLY reference-file writer: post-approval, atomic per file, tier re-checked. */
  applyDrafts(
    syncId: string,
    targets: string[]
  ): { written: string[]; skipped: Array<{ target: string; reason: string }> } {
    const report = this.pendingDrafts.get(syncId)
    if (!report) throw new Error('Sync report expired — run Sync again')
    const written: string[] = []
    const skipped: Array<{ target: string; reason: string }> = []
    const now = this.now()
    for (const target of targets) {
      // defense-in-depth: target ultimately traces back to hand-editable
      // routingRules[].target (plain z.string()) — re-validate the basename
      // before it joins a write path, same philosophy as proposals.ts.
      if (!REF_TARGET_RE.test(target) || target === REFERENCES_INDEX) {
        skipped.push({ target, reason: 'invalid target name' })
        continue
      }
      const draft = report.drafts.find((d) => d.target === target)
      if (!draft) {
        skipped.push({ target, reason: 'no such draft in this sync' })
        continue
      }
      const file = path.join(this.refsDir(), target)
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
      const tier = existing ? refTier(existing) : null
      if (existing && tier !== 'confluence') {
        skipped.push({
          target,
          reason: `trust_tier ${tier ?? 'team-knowledge'} — never auto-overwritten`
        })
        continue
      }
      const oldSources = existing ? parseRefSources(existing) : []
      const fresh: RefSource[] = draft.pages.map((p) => ({
        url: p.url,
        pageId: p.id,
        version: p.version,
        lastSynced: now.toISOString()
      }))
      const keep = oldSources.filter((s) => !fresh.some((f) => f.pageId === s.pageId))
      const title = target.replace(/\.md$/, '').replace(/-/g, ' ')
      const content = stampRefFile(draft.newBody, { title, sources: [...keep, ...fresh], now })
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file + '.tmp', content)
      fs.renameSync(file + '.tmp', file)
      written.push(target)
    }
    if (written.length) {
      // amendment: keep the agent-facing router in step with every applied write
      const indexPath = path.join(this.refsDir(), REFERENCES_INDEX)
      fs.writeFileSync(
        indexPath + '.tmp',
        generateReferencesIndex(this.refsDir(), this.deps.store.get())
      )
      fs.renameSync(indexPath + '.tmp', indexPath)
    }
    const state = readSyncState(this.deps.argusHome)
    const st = state.spaces[report.spaceKey]
    if (st) {
      st.driftTargets = st.driftTargets.filter((t) => !written.includes(t))
      writeSyncState(this.deps.argusHome, state)
    }
    return { written, skipped }
  }

  /**
   * Remove references to pages that vanished upstream, for the targets the user approved.
   *
   * An orphaned file (every source gone) is deleted; a partially-affected one keeps its body
   * and only loses the dead `sources[]` entries, because the surviving pages still justify
   * it. Mirrors applyDrafts' guards exactly — basename re-validated, tier re-checked at the
   * point of write — since `target` traces back to hand-editable config.
   */
  prune(
    syncId: string,
    targets: string[]
  ): { removed: string[]; trimmed: string[]; skipped: Array<{ target: string; reason: string }> } {
    const report = this.pendingDrafts.get(syncId)
    if (!report) throw new Error('Sync report expired — run Sync again')
    const removed: string[] = []
    const trimmed: string[] = []
    const skipped: Array<{ target: string; reason: string }> = []
    const now = this.now()
    for (const target of targets) {
      if (!REF_TARGET_RE.test(target) || target === REFERENCES_INDEX) {
        skipped.push({ target, reason: 'invalid target name' })
        continue
      }
      const entry = report.vanished.find((v) => v.target === target)
      if (!entry) {
        skipped.push({ target, reason: 'not reported as vanished in this sync' })
        continue
      }
      const file = path.join(this.refsDir(), target)
      if (!fs.existsSync(file)) {
        skipped.push({ target, reason: 'file no longer exists' })
        continue
      }
      const raw = fs.readFileSync(file, 'utf8')
      // Re-check the tier at write time: it may have been hand-edited to team-knowledge
      // between the sync and the approval, and a hand-owned file is never auto-removed.
      const tier = refTier(raw)
      if (tier !== 'confluence') {
        skipped.push({
          target,
          reason: `trust_tier ${tier ?? 'team-knowledge'} — never auto-removed`
        })
        continue
      }
      const goneIds = new Set(entry.pages.map((p) => p.pageId))
      const keep = parseRefSources(raw).filter((s) => !goneIds.has(s.pageId))
      if (keep.length === 0) {
        fs.rmSync(file)
        removed.push(target)
        continue
      }
      const content = stampRefFile(refBody(raw), {
        title: refTitle(raw) ?? target.replace(/\.md$/, '').replace(/-/g, ' '),
        sources: keep,
        now
      })
      fs.writeFileSync(file + '.tmp', content)
      fs.renameSync(file + '.tmp', file)
      trimmed.push(target)
    }
    if (removed.length || trimmed.length) {
      // INDEX.md is generated from the directory listing, so an orphan removed here must be
      // dropped from the agent-facing router in the same breath.
      const indexPath = path.join(this.refsDir(), REFERENCES_INDEX)
      fs.writeFileSync(
        indexPath + '.tmp',
        generateReferencesIndex(this.refsDir(), this.deps.store.get())
      )
      fs.renameSync(indexPath + '.tmp', indexPath)
    }
    return { removed, trimmed, skipped }
  }
}
