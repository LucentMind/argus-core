// Composes case/evidence primitives into the ticket-driven lifecycle (spec §3.2–3.3).
// UI-native: called from jira:* IPC handlers only, never by the agent.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CaseRecord, EvidenceRecord } from '../../shared/types'
import { hasUpstreamChange } from '../../shared/triage'
import type {
  JiraAttachmentInfo,
  JiraAttachmentProgress,
  JiraCommentInfo,
  JiraIssuePreview,
  JiraRefreshSummary,
  JiraSourceRefresh,
  JiraSyncAllSummary
} from '../../shared/jira'
import { AtlassianError, type JiraIssueData } from './atlassian'
import {
  addCaseJiraLink,
  createCase,
  getCase,
  listCases,
  listCaseJiraLinks,
  setCaseJira,
  setCaseJiraLinkAttachmentIds,
  setCaseSyncState,
  setReviewBaseline
} from './caseService'
import { ingestArtifact, ingestContent, listEvidence, updateEvidenceContent } from './ingest'
import type { IngestQueueLike } from './ingestQueue'
import type { Detection } from './packs/detection'
import { extractZipToTemp, ArchiveLimitError, type ArchiveLimits } from './archiveExtract'
import { JIRA_PROMPTS } from './jiraPrompts'

export interface AtlassianClientLike {
  getIssue(key: string): Promise<JiraIssueData>
  downloadAttachment(id: string, destPath: string): Promise<void>
  getComments(key: string): Promise<JiraCommentInfo[]>
}

export interface JiraCasesDeps {
  db: DatabaseSync
  argusHome: string
  detection: Detection
  client: AtlassianClientLike
  site: () => string
  /** Owns indexing AND extraction for everything this service ingests — it replaces the
   *  `extractors`/`parsing` pair the inline extraction kick used to need. */
  queue: IngestQueueLike
  emitProgress: (p: JiraAttachmentProgress) => void
  evidenceChanged: (caseSlug: string) => void
  /** Prompt-registry resolver, forwarded to createCase for the case's CLAUDE.md. */
  resolvePrompt?: (id: string) => string
  /** Overridable in tests; production uses ARCHIVE_LIMITS. */
  archiveLimits?: Partial<ArchiveLimits>
}

interface JiraEvidenceMeta {
  key?: string
  role?: string
  status?: string
  attachmentId?: string
  filename?: string
  commentCount?: number
}

const jiraMeta = (meta: Record<string, unknown>): JiraEvidenceMeta =>
  (meta.jira as JiraEvidenceMeta | undefined) ?? {}

/** Evidence lookup MUST be scoped by ticket key: a case can carry evidence from its primary
 *  ticket and from source tickets, and role alone is ambiguous across them. */
const findJiraEvidence = (
  evidence: EvidenceRecord[],
  role: string,
  key: string
): EvidenceRecord | undefined =>
  evidence.find((e) => jiraMeta(e.meta).role === role && jiraMeta(e.meta).key === key)

/** attachmentId → filename for attachments already ingested FROM `key`.
 *  Records stamped with a different key belong to another ticket's diff, not this one.
 *  Records with no key at all are legacy primary-ticket evidence and count for the primary. */
const knownAttachments = (evidence: EvidenceRecord[], key: string): Map<string, string> => {
  const known = new Map<string, string>()
  for (const e of evidence) {
    const m = jiraMeta(e.meta)
    if (!m.attachmentId) continue
    if (m.key !== undefined && m.key !== key) continue
    known.set(m.attachmentId, m.filename ?? e.relPath)
  }
  return known
}

function ticketMarkdown(p: JiraIssuePreview, description: string): string {
  return `# ${p.key}: ${p.summary}

- Status: ${p.status}
- Reporter: ${p.reporter ?? '(unknown)'}
- Labels: ${p.labels.join(', ') || '(none)'}
- Created: ${p.created}
- Updated: ${p.updated}
- Attachments: ${p.attachments.length}

## Description

${description || '_(no description)_'}
`
}

const sanitizeFilename = (name: string): string =>
  path.basename(name.replace(/[\\/:*?"<>|]/g, '_')) || 'attachment'

export function commentsMarkdown(
  key: string,
  comments: JiraCommentInfo[],
  resolve?: (id: string) => string
): string {
  const banner = resolve
    ? resolve('generated-files.jira-comments-banner')
    : JIRA_PROMPTS['jira-comments-banner'].text
  const sections = comments.map((c) => {
    const edited = c.updated && c.updated !== c.created ? ` (edited ${c.updated})` : ''
    return `## ${c.author ?? '(unknown)'} — ${c.created}${edited}\n\n${c.bodyMarkdown || '_(empty)_'}`
  })
  return `# ${key}: comments\n\n${banner}\n\n${sections.join('\n\n') || '_(no comments)_'}\n`
}

const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024 // 500 MB per-attachment cap

const ARCHIVE_LIMITS: ArchiveLimits = {
  maxDepth: 3,
  maxEntries: 1000,
  maxTotalBytes: 5 * 1024 * 1024 * 1024, // 5 GB uncompressed
  maxEntryBytes: MAX_ATTACHMENT_BYTES, // 500 MB per inner file
  maxRatio: 100
}

// Zip local-file-header magic: 'PK\x03\x04'.
function isZipFile(filePath: string): boolean {
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(4)
    fs.readSync(fd, buf, 0, 4, 0)
    return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export class JiraCases {
  constructor(private deps: JiraCasesDeps) {}

  async preview(key: string): Promise<JiraIssuePreview> {
    return (await this.deps.client.getIssue(key)).preview
  }

  async createFromTicket(input: {
    slug: string
    title: string
    key: string
    /** Tickets to link as evidence sources (typically the ticket this one was cloned from). */
    sources?: string[]
  }): Promise<CaseRecord> {
    const { db, argusHome, detection, queue } = this.deps
    const { preview, descriptionMarkdown, raw } = await this.deps.client.getIssue(input.key)
    createCase(
      db,
      argusHome,
      { slug: input.slug, title: input.title, jiraKey: preview.key },
      this.deps.resolvePrompt
    )
    const now = new Date().toISOString()
    ingestContent(
      db,
      argusHome,
      detection,
      queue,
      input.slug,
      `${preview.key}.ticket.md`,
      ticketMarkdown(preview, descriptionMarkdown),
      'jira',
      { jira: { key: preview.key, role: 'ticket', status: preview.status, syncedAt: now } }
    )
    ingestContent(
      db,
      argusHome,
      detection,
      queue,
      input.slug,
      `${preview.key}.ticket.json`,
      JSON.stringify(raw, null, 2),
      'jira',
      { jira: { key: preview.key, role: 'ticket-raw', syncedAt: now } }
    )
    // comments are best-effort at creation: no summary object exists here, so a
    // failure logs and the file appears on the first successful refresh instead.
    // commentCount stays null on failure so setCaseSyncState below omits the key
    // (presence semantics) rather than persisting a wrong count of 0.
    let commentCount: number | null = null
    try {
      const comments = await this.deps.client.getComments(input.key)
      commentCount = comments.length
      ingestContent(
        db,
        argusHome,
        detection,
        queue,
        input.slug,
        `${preview.key}.comments.md`,
        commentsMarkdown(preview.key, comments, this.deps.resolvePrompt),
        'jira',
        {
          jira: { key: preview.key, role: 'comments', commentCount: comments.length, syncedAt: now }
        }
      )
    } catch (err) {
      console.warn(`[jira] comments fetch failed for ${input.key}: ${(err as Error).message}`)
    }
    // Persist the snapshot we just fetched so the first `markReviewed` (fired
    // when the user opens the new case) captures real values instead of the
    // empty defaults from createCase — otherwise the first sync diffs the real
    // upstream state against that empty baseline and reports everything just
    // imported as newly changed. See Finding I1.
    setCaseSyncState(db, argusHome, input.slug, {
      jiraStatus: preview.status,
      jiraPriority: preview.priority,
      jiraAttachmentIds: preview.attachments.map((a) => a.id),
      lastSyncError: null,
      ...(commentCount === null ? {} : { jiraCommentCount: commentCount })
    })
    // Sources are best-effort: a case must exist even if the customer ticket is unreadable.
    // A failure here leaves no link row, so the case simply has no source — recoverable
    // later through the add-source path (increment 2).
    for (const sourceKey of input.sources ?? []) {
      try {
        await this.importSourceTicket(input.slug, sourceKey)
      } catch (err) {
        console.warn(`[jira] source import failed for ${sourceKey}: ${(err as Error).message}`)
      }
    }
    return setCaseJira(db, argusHome, input.slug, {
      key: preview.key,
      site: this.deps.site(),
      lastSyncedAt: now
    })
  }

  /**
   * Link a ticket the case reads evidence FROM (typically the customer ticket this case's
   * clone was made from) and ingest its text, raw JSON and comments. Idempotent: an existing
   * link keeps its attachment baseline and the evidence is updated in place.
   *
   * Attachments are deliberately NOT ingested here. The caller shows the user the source's
   * attachment list unchecked and then calls ingestAttachments(slug, key, chosen) — nothing
   * arrives that the user did not pick.
   */
  async importSourceTicket(caseSlug: string, key: string): Promise<JiraIssuePreview> {
    const { db, argusHome, detection, queue } = this.deps
    const kase = getCase(db, caseSlug)
    if (!kase) throw new AtlassianError('internal', `Unknown case: ${caseSlug}`)
    if (key === kase.jiraKey)
      throw new AtlassianError(
        'internal',
        `${key} is already this case's ticket; it cannot also be a source.`
      )

    const { preview, descriptionMarkdown, raw } = await this.deps.client.getIssue(key)
    const now = new Date().toISOString()
    addCaseJiraLink(db, argusHome, caseSlug, key)

    const evidence = listEvidence(db, caseSlug)
    const write = (role: string, relPath: string, content: string, extra: object = {}): void => {
      const meta = { jira: { key: preview.key, role, syncedAt: now, ...extra } }
      const rec = findJiraEvidence(evidence, role, preview.key)
      if (rec) updateEvidenceContent(db, argusHome, detection, queue, rec.id, content, meta)
      else ingestContent(db, argusHome, detection, queue, caseSlug, relPath, content, 'jira', meta)
    }

    write(
      'source-ticket',
      `${preview.key}.ticket.md`,
      ticketMarkdown(preview, descriptionMarkdown),
      { status: preview.status }
    )
    write('source-ticket-raw', `${preview.key}.ticket.json`, JSON.stringify(raw, null, 2))

    // Best-effort, exactly like createFromTicket's comments fetch: a source whose comments
    // are unreadable must not cost the user the ticket text they came for.
    try {
      const comments = await this.deps.client.getComments(key)
      write(
        'source-comments',
        `${preview.key}.comments.md`,
        commentsMarkdown(preview.key, comments, this.deps.resolvePrompt),
        { commentCount: comments.length }
      )
    } catch (err) {
      console.warn(`[jira] source comments fetch failed for ${key}: ${(err as Error).message}`)
    }

    this.deps.evidenceChanged(caseSlug)
    return preview
  }

  /** Sequential per-file download+ingest; failures are per-file and never abort the batch.
   *  `jiraKey` is passed, never derived from the case: attachments can come from a SOURCE
   *  ticket, and deriving would attribute the customer's files to the clone. */
  async ingestAttachments(
    caseSlug: string,
    jiraKey: string,
    attachments: JiraAttachmentInfo[]
  ): Promise<JiraAttachmentProgress[]> {
    const { db, argusHome, detection, queue } = this.deps
    const kase = getCase(db, caseSlug)
    if (!kase) throw new AtlassianError('internal', `Unknown case: ${caseSlug}`)
    const key = jiraKey
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-jira-'))
    const results: JiraAttachmentProgress[] = []
    try {
      for (const a of attachments) {
        const base = { caseSlug, attachmentId: a.id, filename: a.filename }
        // size is always present on Jira attachment metadata; a missing/0 size fails
        // open to download (then bounded by the streaming idle timeout).
        if (a.size > MAX_ATTACHMENT_BYTES) {
          const mb = Math.round(a.size / (1024 * 1024))
          const failed: JiraAttachmentProgress = {
            ...base,
            status: 'error',
            error: `Attachment is ${mb} MB; exceeds the 500 MB limit`
          }
          this.deps.emitProgress(failed)
          results.push(failed)
          continue
        }
        this.deps.emitProgress({ ...base, status: 'downloading' })
        try {
          const tmpFile = path.join(tmpDir, sanitizeFilename(a.filename))
          await this.deps.client.downloadAttachment(a.id, tmpFile)
          // ingestArtifact enqueues indexing + extraction; the queue emits its own
          // progress, which is why no `parsing` broadcast is kicked off here any more.
          const rec = await ingestArtifact(
            db,
            argusHome,
            detection,
            queue,
            caseSlug,
            tmpFile,
            'jira',
            {
              jira: { key, attachmentId: a.id, filename: a.filename }
            }
          )
          this.deps.evidenceChanged(caseSlug)
          const done: JiraAttachmentProgress = { ...base, status: 'done', evidenceId: rec.id }
          // Explode ONLY genuine .zip archives, not merely zip-structured files:
          //  - rec.artifactType === 'archive' — the generic archive type; excludes
          //    files a pack detector already claimed (e.g. .bintrace.zip -> type
          //    'bintrace'), which have their own extractor and must not be
          //    double-processed.
          //  - /\.zip$/i — excludes Office docs (.docx/.xlsx/.pptx) and .jar/.apk,
          //    which are ZIP-structured but not .zip-named.
          //  - isZipFile(tmpFile) — magic-byte confirmation; excludes a .zip-named
          //    gzip/tar (our extractor only reads zip).
          if (rec.artifactType === 'archive' && /\.zip$/i.test(a.filename) && isZipFile(tmpFile)) {
            try {
              done.extractedCount = await this.ingestArchiveContents(caseSlug, a, tmpFile, tmpDir)
            } catch (err) {
              // The archive itself ingested fine; only extraction failed. Keep the
              // archive, surface the reason, leave status 'done'.
              done.extractError =
                err instanceof ArchiveLimitError
                  ? `Archive not expanded (${err.kind}): ${err.message}`
                  : `Archive not expanded: ${(err as Error).message}`
              console.warn(
                `[jira] archive extraction failed for ${a.filename}: ${(err as Error).message}`
              )
            }
          }
          this.deps.emitProgress(done)
          results.push(done)
        } catch (err) {
          const failed: JiraAttachmentProgress = {
            ...base,
            status: 'error',
            error: (err as Error).message
          }
          this.deps.emitProgress(failed)
          results.push(failed)
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    return results
  }

  /** Expand a zip attachment: stage inner files under caps, then ingest each as
   *  its own evidence record. All-or-nothing — a cap breach throws and ingests
   *  nothing (the caller keeps the archive and surfaces the error). Returns the
   *  number of inner files ingested. */
  private async ingestArchiveContents(
    caseSlug: string,
    attachment: JiraAttachmentInfo,
    zipPath: string,
    tmpDir: string
  ): Promise<number> {
    const { db, argusHome, detection, queue } = this.deps
    const limits: ArchiveLimits = { ...ARCHIVE_LIMITS, ...(this.deps.archiveLimits ?? {}) }
    const stageDir = fs.mkdtempSync(path.join(tmpDir, 'x-'))
    try {
      // Phase 1: validate + stage (throws on any breach — nothing ingested yet).
      const { entries } = await extractZipToTemp(zipPath, stageDir, limits)
      // Phase 2: ingest every staged inner file.
      for (const e of entries) {
        // Preserve the archive-relative name so collision-free naming + display read well.
        const named = path.join(stageDir, sanitizeFilename(path.basename(e.innerPath)))
        if (named !== e.tempPath) fs.renameSync(e.tempPath, named)
        await ingestArtifact(db, argusHome, detection, queue, caseSlug, named, 'jira', {
          extractedFrom: {
            attachmentId: attachment.id,
            archiveName: attachment.filename,
            innerPath: e.innerPath
          }
        })
      }
      if (entries.length) this.deps.evidenceChanged(caseSlug)
      return entries.length
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true })
    }
  }

  async refresh(caseSlug: string): Promise<JiraRefreshSummary> {
    const { db, argusHome, detection, queue } = this.deps
    const kase = getCase(db, caseSlug)
    if (!kase?.jiraKey)
      throw new AtlassianError('not-configured', `Case ${caseSlug} has no linked Jira ticket.`)
    const { preview, descriptionMarkdown, raw } = await this.deps.client.getIssue(kase.jiraKey)
    const now = new Date().toISOString()
    const evidence = listEvidence(db, caseSlug)

    // ticket evidence: update in place (or create if missing from an older case)
    const mdRec = findJiraEvidence(evidence, 'ticket', preview.key)
    const oldStatus = mdRec ? (jiraMeta(mdRec.meta).status ?? '') : ''
    const mdMeta = {
      jira: { key: preview.key, role: 'ticket', status: preview.status, syncedAt: now }
    }
    if (mdRec)
      updateEvidenceContent(
        db,
        argusHome,
        detection,
        queue,
        mdRec.id,
        ticketMarkdown(preview, descriptionMarkdown),
        mdMeta
      )
    else
      ingestContent(
        db,
        argusHome,
        detection,
        queue,
        caseSlug,
        `${preview.key}.ticket.md`,
        ticketMarkdown(preview, descriptionMarkdown),
        'jira',
        mdMeta
      )
    const rawRec = findJiraEvidence(evidence, 'ticket-raw', preview.key)
    const rawMeta = { jira: { key: preview.key, role: 'ticket-raw', syncedAt: now } }
    if (rawRec)
      updateEvidenceContent(
        db,
        argusHome,
        detection,
        queue,
        rawRec.id,
        JSON.stringify(raw, null, 2),
        rawMeta
      )
    else
      ingestContent(
        db,
        argusHome,
        detection,
        queue,
        caseSlug,
        `${preview.key}.ticket.json`,
        JSON.stringify(raw, null, 2),
        'jira',
        rawMeta
      )

    // comments evidence: update in place (or create if missing), tolerating fetch failure
    let newComments = 0
    let commentCount: number | null = null
    let commentsError: string | undefined
    try {
      const comments = await this.deps.client.getComments(kase.jiraKey)
      const cmRec = findJiraEvidence(evidence, 'comments', preview.key)
      const oldCount = cmRec ? (jiraMeta(cmRec.meta).commentCount ?? 0) : 0
      newComments = Math.max(0, comments.length - oldCount)
      commentCount = comments.length
      const cmMeta = {
        jira: { key: preview.key, role: 'comments', commentCount: comments.length, syncedAt: now }
      }
      const content = commentsMarkdown(preview.key, comments, this.deps.resolvePrompt)
      if (cmRec) updateEvidenceContent(db, argusHome, detection, queue, cmRec.id, content, cmMeta)
      else
        ingestContent(
          db,
          argusHome,
          detection,
          queue,
          caseSlug,
          `${preview.key}.comments.md`,
          content,
          'jira',
          cmMeta
        )
    } catch (err) {
      commentsError = (err as Error).message
    }

    this.deps.evidenceChanged(caseSlug)

    // Attachment diff by id. Refresh NEVER downloads: new ids (neither ingested
    // nor deselected) are returned for the renderer's selection dialog, which
    // ingests via jira:ingest-attachments and persists deselection. Spec:
    // docs/superpowers/specs/2026-07-17-jira-comments-evidence-scan-design.md §4.
    const known = knownAttachments(evidence, preview.key)
    const deselected = new Set(kase.jiraDeselected)
    const fresh = preview.attachments.filter((a) => !known.has(a.id) && !deselected.has(a.id))
    const deselectedAttachments = preview.attachments.filter((a) => deselected.has(a.id))
    const ingestedAttachments = preview.attachments.filter((a) => known.has(a.id))
    const liveIds = new Set(preview.attachments.map((a) => a.id))
    const deletedOnJira = [...known.entries()]
      .filter(([id]) => !liveIds.has(id))
      .map(([attachmentId, filename]) => ({ attachmentId, filename }))

    // Persist the upstream snapshot the dashboard diffs against. commentCount
    // stays null when the comments fetch failed, so a partial refresh never
    // clobbers a known-good count with a wrong one.
    setCaseSyncState(db, argusHome, caseSlug, {
      jiraStatus: preview.status,
      jiraPriority: preview.priority,
      jiraAttachmentIds: preview.attachments.map((a) => a.id),
      lastSyncError: null,
      ...(commentCount === null ? {} : { jiraCommentCount: commentCount })
    })
    setCaseJira(db, argusHome, caseSlug, {
      key: preview.key,
      site: this.deps.site(),
      lastSyncedAt: now
    })

    // Source tickets refresh AFTER the primary and each is fully contained: a source may be
    // archived, restricted or deleted upstream, and none of that may fail the refresh of the
    // ticket the user is actually working. Same posture as the comments fetch above.
    const sources: JiraSourceRefresh[] = []
    for (const link of listCaseJiraLinks(db, caseSlug)) {
      try {
        const before = findJiraEvidence(listEvidence(db, caseSlug), 'source-comments', link.key)
        const oldComments = before ? (jiraMeta(before.meta).commentCount ?? 0) : 0
        const sourcePreview = await this.importSourceTicket(caseSlug, link.key)
        const after = findJiraEvidence(listEvidence(db, caseSlug), 'source-comments', link.key)
        const newCount = after ? (jiraMeta(after.meta).commentCount ?? 0) : 0

        // Diff against THIS link's baseline, not the case-level list (which is the primary's).
        // Attachments already ingested from this source are excluded too, so a re-import never
        // re-offers a file the user already has.
        const baseline = new Set(link.attachmentIds)
        const ingested = knownAttachments(listEvidence(db, caseSlug), link.key)
        sources.push({
          key: link.key,
          newComments: Math.max(0, newCount - oldComments),
          newAttachments: sourcePreview.attachments.filter(
            (a) => !baseline.has(a.id) && !ingested.has(a.id)
          )
        })
        setCaseJiraLinkAttachmentIds(
          db,
          caseSlug,
          link.key,
          sourcePreview.attachments.map((a) => a.id)
        )
      } catch (err) {
        sources.push({
          key: link.key,
          newComments: 0,
          newAttachments: [],
          error: (err as Error).message
        })
      }
    }

    return {
      key: preview.key,
      statusChange:
        oldStatus && oldStatus !== preview.status ? { from: oldStatus, to: preview.status } : null,
      newAttachments: fresh,
      deselectedAttachments,
      ingestedAttachments,
      deletedOnJira,
      newComments,
      sources,
      ...(commentsError ? { commentsError } : {}),
      syncedAt: now
    }
  }

  /**
   * Refresh every non-closed, Jira-linked case. Reuses the per-case refresh()
   * wholesale — the only added logic is fan-out, a concurrency bound, and
   * per-case error capture. One case failing never aborts the run.
   *
   * Never downloads attachments: refresh() returns new ones for the renderer's
   * selection dialog, and N dialogs racing would be unusable. The card reports
   * the count; ingestion happens inside the case.
   */
  async syncAll(onProgress?: (done: number, total: number) => void): Promise<JiraSyncAllSummary> {
    const { db, argusHome } = this.deps
    const targets = listCases(db).filter((c) => c.jiraKey && c.status !== 'closed')
    const total = targets.length
    const failures: JiraSyncAllSummary['failures'] = []
    const succeeded = new Set<string>()
    let synced = 0
    let done = 0

    const CONCURRENCY = 4
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++
        if (i >= targets.length) return
        const kase = targets[i]
        try {
          await this.refresh(kase.slug)
          synced++
          succeeded.add(kase.slug)
        } catch (err) {
          const code = err instanceof AtlassianError ? err.code : 'internal'
          const message = (err as Error).message
          failures.push({ slug: kase.slug, code, message })
          setCaseSyncState(db, argusHome, kase.slug, {
            lastSyncError: { code, message, at: new Date().toISOString() }
          })
        } finally {
          // A throwing onProgress must never abort the run: this sits in a
          // `finally`, and an exception thrown here is NOT caught by the
          // `catch` above — it would propagate out of the worker, reject
          // Promise.all, and abandon every un-started case. Progress
          // reporting is best-effort only. Do not remove this guard.
          try {
            onProgress?.(++done, total)
          } catch (err) {
            console.warn(
              `[jira] onProgress callback threw: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()))

    // Recompute after the run so `changed` reflects persisted state, not the
    // transient per-refresh summaries. Only cases that actually SUCCEEDED this
    // run count: a case that FAILED gets a fresh `sync-error` action item from
    // its own lastSyncError, which would make "changed" count outages as
    // changes. A succeeded case can't carry a sync-error item — refresh()
    // clears lastSyncError on success.
    //
    // hasUpstreamChange, not `length > 0`: info-severity items (`stale`,
    // `idle`) describe our own sync cadence, not the ticket. Today a succeeded
    // case cannot carry one — a successful refresh stamps jira_synced_at to
    // now, which clears `stale` — so this is a semantic guard, not a live bug
    // fix. It stops the count inflating the moment any info item becomes
    // reachable post-sync (`idle` is already declared but unemitted).
    const changed = listCases(db).filter(
      (c) => succeeded.has(c.slug) && hasUpstreamChange(c.actionItems)
    ).length

    return {
      total,
      synced,
      changed,
      failed: failures.length,
      failures,
      finishedAt: new Date().toISOString()
    }
  }

  /**
   * Snapshot current upstream state as the review baseline — this is what
   * clears a card's action items. Called when the user opens a case.
   *
   * Synchronous and DB-only: it deliberately does NOT hit Jira, so opening a
   * case is instant and works offline. It marks "reviewed as of what we last
   * synced", which is exactly what the user just saw on the card.
   */
  markReviewed(caseSlug: string): CaseRecord {
    const { db, argusHome } = this.deps
    const kase = getCase(db, caseSlug)
    if (!kase) throw new Error(`Unknown case: ${caseSlug}`)
    return setReviewBaseline(db, argusHome, caseSlug, {
      status: kase.jiraStatus ?? '',
      commentCount: kase.jiraCommentCount ?? 0,
      attachmentIds: [...kase.jiraAttachmentIds],
      capturedAt: new Date().toISOString()
    })
  }
}
