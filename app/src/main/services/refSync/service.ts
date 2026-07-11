import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sharedReferencesDir } from '../skillsDir'
import { ReferenceSyncStore, readSyncState, writeSyncState } from '../referenceSyncStore'
import {
  walkSelection,
  computeChangedSet,
  referenceStatuses,
  generateReferencesIndex,
  type ConfluenceReader
} from './engine'
import { distillTarget, type DistillOptions } from './distill'
import { refBody, refTier, parseRefSources, stampRefFile, type RefSource } from './refFrontmatter'
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
import type { CreateQueryFn } from '../agent/session'

export interface RefSyncServiceDeps {
  argusHome: string
  store: ReferenceSyncStore
  reader: ConfluenceReader
  createQuery?: CreateQueryFn
  distillOptions?: () => DistillOptions
  /** Injectable for tests; defaults to the headless SDK distiller. */
  distill?: typeof distillTarget
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
          this.deps.distillOptions?.() ?? {},
          this.deps.createQuery
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
    state.spaces[spaceKey] = {
      lastSyncedAt: this.now().toISOString(),
      seenPages: Object.fromEntries(
        selected.map((p) => [p.id, { version: p.version, lastModified: p.lastModified }])
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
      failures
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
}
