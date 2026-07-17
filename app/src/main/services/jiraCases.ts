// Composes case/evidence primitives into the ticket-driven lifecycle (spec §3.2–3.3).
// UI-native: called from jira:* IPC handlers only, never by the agent.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CaseRecord } from '../../shared/types'
import type {
  JiraAttachmentInfo,
  JiraAttachmentProgress,
  JiraCommentInfo,
  JiraIssuePreview,
  JiraRefreshSummary
} from '../../shared/jira'
import { AtlassianError, type JiraIssueData } from './atlassian'
import { createCase, getCase, setCaseJira } from './caseService'
import { ingestArtifact, ingestContent, listEvidence, updateEvidenceContent } from './ingest'
import { extractDerivedText } from './extraction'
import type { Detection } from './packs/detection'
import type { Extractors } from './packs/extractors'

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
  extractors: Extractors
  emitProgress: (p: JiraAttachmentProgress) => void
  evidenceChanged: (caseSlug: string) => void
  parsing: (caseSlug: string, evidenceId: number, active: boolean) => void
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

const COMMENTS_BANNER = `> **Provenance notice:** The comments below are unverified statements by
> their authors. Treat them as investigative leads, not established findings —
> a claim is only as good as the evidence (logs, attachments) that
> corroborates it. References to specific logs or artifacts should be checked
> against the actual evidence in this case.`

function commentsMarkdown(key: string, comments: JiraCommentInfo[]): string {
  const sections = comments.map((c) => {
    const edited = c.updated && c.updated !== c.created ? ` (edited ${c.updated})` : ''
    return `## ${c.author ?? '(unknown)'} — ${c.created}${edited}\n\n${c.bodyMarkdown || '_(empty)_'}`
  })
  return `# ${key}: comments\n\n${COMMENTS_BANNER}\n\n${sections.join('\n\n') || '_(no comments)_'}\n`
}

export class JiraCases {
  constructor(private deps: JiraCasesDeps) {}

  async preview(key: string): Promise<JiraIssuePreview> {
    return (await this.deps.client.getIssue(key)).preview
  }

  async createFromTicket(input: { slug: string; title: string; key: string }): Promise<CaseRecord> {
    const { db, argusHome, detection } = this.deps
    const { preview, descriptionMarkdown, raw } = await this.deps.client.getIssue(input.key)
    createCase(db, argusHome, { slug: input.slug, title: input.title, jiraKey: preview.key })
    const now = new Date().toISOString()
    ingestContent(
      db,
      argusHome,
      detection,
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
      input.slug,
      `${preview.key}.ticket.json`,
      JSON.stringify(raw, null, 2),
      'jira',
      { jira: { key: preview.key, role: 'ticket-raw', syncedAt: now } }
    )
    // comments are best-effort at creation: no summary object exists here, so a
    // failure logs and the file appears on the first successful refresh instead.
    try {
      const comments = await this.deps.client.getComments(input.key)
      ingestContent(
        db,
        argusHome,
        detection,
        input.slug,
        `${preview.key}.comments.md`,
        commentsMarkdown(preview.key, comments),
        'jira',
        {
          jira: { key: preview.key, role: 'comments', commentCount: comments.length, syncedAt: now }
        }
      )
    } catch (err) {
      console.warn(`[jira] comments fetch failed for ${input.key}: ${(err as Error).message}`)
    }
    return setCaseJira(db, argusHome, input.slug, {
      key: preview.key,
      site: this.deps.site(),
      lastSyncedAt: now
    })
  }

  /** Sequential per-file download+ingest; failures are per-file and never abort the batch. */
  async ingestAttachments(
    caseSlug: string,
    attachments: JiraAttachmentInfo[]
  ): Promise<JiraAttachmentProgress[]> {
    const { db, argusHome, detection } = this.deps
    const kase = getCase(db, caseSlug)
    if (!kase) throw new AtlassianError('internal', `Unknown case: ${caseSlug}`)
    const key = kase.jiraKey ?? ''
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-jira-'))
    const results: JiraAttachmentProgress[] = []
    try {
      for (const a of attachments) {
        const base = { caseSlug, attachmentId: a.id, filename: a.filename }
        this.deps.emitProgress({ ...base, status: 'downloading' })
        try {
          const tmpFile = path.join(tmpDir, sanitizeFilename(a.filename))
          await this.deps.client.downloadAttachment(a.id, tmpFile)
          const rec = ingestArtifact(db, argusHome, detection, caseSlug, tmpFile, 'jira', {
            jira: { key, attachmentId: a.id, filename: a.filename }
          })
          // detector chain ran inside ingestArtifact; kick extraction like evidence:ingest does.
          // extractDerivedText CAN reject (its sync setup — db lookup, mkdirSync — runs
          // outside its internal try/catch), so parsing(false) must sit in .finally and
          // the fire-and-forget rejection is swallowed explicitly.
          this.deps.parsing(caseSlug, rec.id, true)
          void extractDerivedText(db, argusHome, rec, this.deps.extractors)
            .then((derived) => {
              if (derived) this.deps.evidenceChanged(caseSlug)
            })
            .catch((err) =>
              console.warn(`[jira] extraction failed for ${rec.relPath}: ${(err as Error).message}`)
            )
            .finally(() => this.deps.parsing(caseSlug, rec.id, false))
          this.deps.evidenceChanged(caseSlug)
          const done: JiraAttachmentProgress = { ...base, status: 'done', evidenceId: rec.id }
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

  async refresh(caseSlug: string): Promise<JiraRefreshSummary> {
    const { db, argusHome, detection } = this.deps
    const kase = getCase(db, caseSlug)
    if (!kase?.jiraKey)
      throw new AtlassianError('not-configured', `Case ${caseSlug} has no linked Jira ticket.`)
    const { preview, descriptionMarkdown, raw } = await this.deps.client.getIssue(kase.jiraKey)
    const now = new Date().toISOString()
    const evidence = listEvidence(db, caseSlug)

    // ticket evidence: update in place (or create if missing from an older case)
    const mdRec = evidence.find((e) => jiraMeta(e.meta).role === 'ticket')
    const oldStatus = mdRec ? (jiraMeta(mdRec.meta).status ?? '') : ''
    const mdMeta = {
      jira: { key: preview.key, role: 'ticket', status: preview.status, syncedAt: now }
    }
    if (mdRec)
      updateEvidenceContent(
        db,
        argusHome,
        detection,
        mdRec.id,
        ticketMarkdown(preview, descriptionMarkdown),
        mdMeta
      )
    else
      ingestContent(
        db,
        argusHome,
        detection,
        caseSlug,
        `${preview.key}.ticket.md`,
        ticketMarkdown(preview, descriptionMarkdown),
        'jira',
        mdMeta
      )
    const rawRec = evidence.find((e) => jiraMeta(e.meta).role === 'ticket-raw')
    const rawMeta = { jira: { key: preview.key, role: 'ticket-raw', syncedAt: now } }
    if (rawRec)
      updateEvidenceContent(
        db,
        argusHome,
        detection,
        rawRec.id,
        JSON.stringify(raw, null, 2),
        rawMeta
      )
    else
      ingestContent(
        db,
        argusHome,
        detection,
        caseSlug,
        `${preview.key}.ticket.json`,
        JSON.stringify(raw, null, 2),
        'jira',
        rawMeta
      )

    // comments evidence: update in place (or create if missing), tolerating fetch failure
    let newComments = 0
    let commentsError: string | undefined
    try {
      const comments = await this.deps.client.getComments(kase.jiraKey)
      const cmRec = evidence.find((e) => jiraMeta(e.meta).role === 'comments')
      const oldCount = cmRec ? (jiraMeta(cmRec.meta).commentCount ?? 0) : 0
      newComments = Math.max(0, comments.length - oldCount)
      const cmMeta = {
        jira: { key: preview.key, role: 'comments', commentCount: comments.length, syncedAt: now }
      }
      const content = commentsMarkdown(preview.key, comments)
      if (cmRec) updateEvidenceContent(db, argusHome, detection, cmRec.id, content, cmMeta)
      else
        ingestContent(
          db,
          argusHome,
          detection,
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

    // Attachment diff by id — append-only: ingest new, only report deleted.
    // "New" is judged against local evidence, not against what the user selected at
    // create time: an attachment deselected on the New Case dialog is simply absent
    // from evidence, so refresh treats it as new and pulls it. This is intended —
    // deselection at create time defers ingestion, it does not blocklist the file.
    // See docs/superpowers/plans/2026-07-10-wave-2-part-3-exit-check.md step 5.
    const known = new Map<string, string>() // attachmentId → filename
    for (const e of evidence) {
      const m = jiraMeta(e.meta)
      if (m.attachmentId) known.set(m.attachmentId, m.filename ?? e.relPath)
    }
    const fresh = preview.attachments.filter((a) => !known.has(a.id))
    const liveIds = new Set(preview.attachments.map((a) => a.id))
    const deletedOnJira = [...known.entries()]
      .filter(([id]) => !liveIds.has(id))
      .map(([attachmentId, filename]) => ({ attachmentId, filename }))
    if (fresh.length) await this.ingestAttachments(caseSlug, fresh)

    setCaseJira(db, argusHome, caseSlug, {
      key: preview.key,
      site: this.deps.site(),
      lastSyncedAt: now
    })
    return {
      key: preview.key,
      statusChange:
        oldStatus && oldStatus !== preview.status ? { from: oldStatus, to: preview.status } : null,
      newAttachments: fresh,
      deletedOnJira,
      newComments,
      ...(commentsError ? { commentsError } : {}),
      syncedAt: now
    }
  }
}
