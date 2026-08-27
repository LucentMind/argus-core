import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { PostResults } from '../../../shared/rca'
import type { AppSettings } from '../../../shared/settings'
import { applyWatermark } from '../../../shared/watermark'
import { getCase } from '../caseService'
import { artifactsDir } from '../paths'
import type { TicketProvider } from '../tickets/provider'

export interface PostGithubDeps {
  db: DatabaseSync
  argusHome: string
  settings: () => AppSettings
  provider: TicketProvider
}

interface JobRow {
  id: number
  post_results: string | null
}

const nowIso = (): string => new Date().toISOString()

/**
 * GitHub has no comment-attachment API, so the whole report goes in ONE comment: exec summary
 * as visible prose, technical detail inside a collapsed <details>. One call, one thing to
 * retry, and no way to leave half a report on a possibly public issue.
 */
function commentBody(execMd: string, techMd: string): string {
  return `${execMd}\n\n<details>\n<summary>Full technical RCA</summary>\n\n${techMd}\n\n</details>\n`
}

export async function postRcaToGithub(deps: PostGithubDeps, slug: string): Promise<PostResults> {
  const kase = getCase(deps.db, slug)
  if (!kase) throw new Error(`Unknown case: ${slug}`)
  if (!kase.jiraKey) throw new Error('This case has no linked GitHub issue.')

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

  // Already posted — do not duplicate it on a retry of some other target.
  if (!results.comment?.ok) {
    try {
      // Watermark LAST so the disclosure is the comment's footer.
      const body = applyWatermark(commentBody(execMd, techMd), deps.settings().watermark.github)
      await deps.provider.postComment(kase.jiraKey, body)
      results.comment = { ok: true, at: nowIso() }
    } catch (err) {
      results.comment = { ok: false, error: (err as Error).message, at: nowIso() }
    }
  }

  deps.db
    .prepare(`UPDATE rca_jobs SET post_results = ? WHERE id = ?`)
    .run(JSON.stringify(results), job.id)
  return results
}
