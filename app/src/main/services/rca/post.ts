import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { PostResults } from '../../../shared/rca'
import type { AppSettings } from '../../../shared/settings'
import { getCase } from '../caseService'
import { artifactsDir } from '../paths'

export interface PostRcaDeps {
  db: DatabaseSync
  argusHome: string
  settings: () => AppSettings
  callTool: (instanceId: string, name: string, args: Record<string, unknown>) => Promise<string>
  uploadAttachment: (
    key: string,
    filename: string,
    content: string
  ) => Promise<{ id: string; filename: string }>
  /** Finds the preset==='rovo' connector; throws the same not-configured message as
   *  `resolveAtlassianCreds` when none exists. */
  resolveRovoInstanceId: () => string
  /** AtlassianClient.resolveSiteUrl(instanceId) — used both as the tool calls' `cloudId`
   *  (a site URL is an accepted cloudId form) and for the Confluence page link fallback. */
  siteUrl: () => Promise<string | null>
}

interface JobRow {
  id: number
  post_results: string | null
}

/** First http(s) URL in a tool's free-text response, or null. Rovo's create-page tools return
 *  human-readable text ("Created page ... at <url>") rather than structured JSON. */
function extractFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/\S+/)
  if (!m) return null
  return m[0].replace(/[)\].,;]+$/, '') // trim trailing punctuation a sentence wrapped it in
}

function nowIso(): string {
  return new Date().toISOString()
}

function attachmentNote(filename: string): string {
  return `\n\n_Full technical RCA attached as **${filename}**._`
}

function confluenceNote(url: string | undefined, title: string): string {
  return url
    ? `\n\n_Full technical RCA: ${url}_`
    : `\n\n_Full technical RCA published to Confluence ("${title}")._`
}

/**
 * Posts a confirmed RCA report to Jira/Confluence via the Rovo MCP connector: the technical
 * drill-down first (attachment or Confluence page per `settings.rca.techDestination`), then an
 * exec-summary Jira comment that references it. Each target runs in its own try/catch — a
 * failure on one never blocks the other — and results are merged onto (never replacing) any
 * `post_results` already on the newest confirmed `rca_jobs` row, so retrying one target keeps
 * the other's prior record intact.
 *
 * A target already recorded `ok: true` is NOT re-attempted — retrying a partial failure must
 * not re-post a comment or duplicate a page/attachment that already succeeded. When the tech
 * target is skipped this way, the exec comment's `techNote` (if the comment itself still needs
 * posting) is derived from that PRIOR record — its `url` for a Confluence page, or the
 * deterministic `rca-<slug>.md` filename for an attachment — never from a fresh call. A mode
 * switch between calls (`techDestination` changed) always posts the newly-selected target,
 * since its record won't be `ok: true` yet.
 */
export async function postRcaReport(deps: PostRcaDeps, slug: string): Promise<PostResults> {
  const kase = getCase(deps.db, slug)
  if (!kase) throw new Error(`Unknown case: ${slug}`)
  if (!kase.jiraKey) throw new Error('This case has no linked Jira issue.')

  const job = deps.db
    .prepare(
      `SELECT id, post_results FROM rca_jobs
       WHERE case_slug = ? AND confirmed_at IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(slug) as JobRow | undefined
  if (!job) throw new Error('No confirmed RCA report to post — confirm the draft first.')

  const dir = artifactsDir(deps.argusHome, slug)
  const execMd = fs.readFileSync(path.join(dir, 'rca-exec.md'), 'utf8')
  const techMd = fs.readFileSync(path.join(dir, 'rca-tech.md'), 'utf8')

  const results: PostResults = job.post_results ? (JSON.parse(job.post_results) as PostResults) : {}
  const cfg = deps.settings().rca
  const rovo = deps.resolveRovoInstanceId()

  // Both Rovo tool calls need a cloudId; without a resolvable site there is nothing postable —
  // fail loudly up front rather than silently passing `undefined` into a required tool argument.
  const cloudId = await deps.siteUrl()
  if (!cloudId) {
    throw new Error(
      'Cannot resolve the Atlassian site for posting — authorize the connector in Settings → Connectors.'
    )
  }

  let techNote = ''
  if (cfg.techDestination === 'attachment') {
    if (results.attachment?.ok) {
      // Already posted — do not re-upload (would duplicate the Jira attachment). The exec
      // comment (if it still needs posting) references the deterministic filename, which is
      // stable across calls regardless of whether this run or a prior one produced it.
      techNote = attachmentNote(`rca-${slug}.md`)
    } else {
      try {
        const a = await deps.uploadAttachment(kase.jiraKey, `rca-${slug}.md`, techMd)
        results.attachment = { ok: true, id: a.id, at: nowIso() }
        techNote = attachmentNote(a.filename)
      } catch (err) {
        results.attachment = { ok: false, error: (err as Error).message, at: nowIso() }
      }
    }
  } else {
    const title = `RCA — ${kase.title} (${kase.jiraKey})`
    if (results.confluencePage?.ok) {
      // Already posted — do not create a duplicate page. Reuse the prior record's url.
      techNote = confluenceNote(results.confluencePage.url, title)
    } else {
      try {
        const raw = await deps.callTool(rovo, 'createConfluencePage', {
          cloudId,
          // settings.rca.confluenceSpaceKey holds a space *key* (e.g. "ENG"), not a numeric
          // id — the tool's `spaceId` argument accepts and auto-resolves a key, so no lookup
          // is needed.
          spaceId: cfg.confluenceSpaceKey,
          title,
          body: techMd,
          contentFormat: 'markdown'
        })
        const url = extractFirstUrl(raw)
        results.confluencePage = { ok: true, url: url ?? undefined, at: nowIso() }
        techNote = confluenceNote(url ?? undefined, title)
      } catch (err) {
        results.confluencePage = { ok: false, error: (err as Error).message, at: nowIso() }
      }
    }
  }

  if (!results.comment?.ok) {
    try {
      await deps.callTool(rovo, 'addCommentToJiraIssue', {
        cloudId,
        issueIdOrKey: kase.jiraKey,
        commentBody: execMd + techNote,
        contentFormat: 'markdown'
      })
      results.comment = { ok: true, at: nowIso() }
    } catch (err) {
      results.comment = { ok: false, error: (err as Error).message, at: nowIso() }
    }
  }
  // else: comment already posted — do not duplicate it; keep the existing record.

  deps.db
    .prepare(`UPDATE rca_jobs SET post_results = ? WHERE id = ?`)
    .run(JSON.stringify(results), job.id)
  return results
}
