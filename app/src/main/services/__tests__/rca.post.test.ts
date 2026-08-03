import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { artifactsDir } from '../paths'
import { postRcaReport, type PostRcaDeps } from '../rca/post'
import { defaultSettings, type AppSettings } from '../../../shared/settings'

let home: string
let db: DatabaseSync

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rca-post-'))
  db = openDb(path.join(home, 'argus.db'))
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

/** Writes the two confirmed-report artifact files a real `RcaJobs.confirm()` would have
 *  produced — postRcaReport reads these directly off disk, never from the DB. */
function writeArtifacts(slug: string, execMd = '# exec', techMd = '# tech'): void {
  const dir = artifactsDir(home, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'rca-exec.md'), execMd)
  fs.writeFileSync(path.join(dir, 'rca-tech.md'), techMd)
}

function insertJob(
  slug: string,
  opts: { confirmed?: boolean; postResults?: unknown } = {}
): number {
  const { confirmed = true, postResults } = opts
  const r = db
    .prepare(
      `INSERT INTO rca_jobs (case_slug, state, input_snapshot, created_at, confirmed_at, post_results)
       VALUES (?, 'done', '{}', '2026-01-01', ?, ?)`
    )
    .run(
      slug,
      confirmed ? '2026-01-02' : null,
      postResults != null ? JSON.stringify(postResults) : null
    )
  return Number(r.lastInsertRowid)
}

function rcaSettings(patch: Partial<AppSettings['rca']> = {}): () => AppSettings {
  const base = defaultSettings()
  return () => ({ ...base, rca: { ...base.rca, ...patch } })
}

interface FakeDepsOpts {
  techDestination?: 'attachment' | 'confluence-page'
  confluenceSpaceKey?: string
  uploadAttachment?: PostRcaDeps['uploadAttachment']
  callTool?: PostRcaDeps['callTool']
  siteUrl?: PostRcaDeps['siteUrl']
  calls?: { tool: string; instanceId: string; args: Record<string, unknown> }[]
}

function fakeDeps(opts: FakeDepsOpts = {}): PostRcaDeps {
  const calls = opts.calls ?? []
  return {
    db,
    argusHome: home,
    settings: rcaSettings({
      techDestination: opts.techDestination ?? 'attachment',
      confluenceSpaceKey: opts.confluenceSpaceKey ?? ''
    }),
    callTool:
      opts.callTool ??
      (async (instanceId, name, args) => {
        calls.push({ tool: name, instanceId, args })
        if (name === 'createConfluencePage')
          return 'Created: https://example.atlassian.net/wiki/x/ABC123'
        return 'ok'
      }),
    uploadAttachment:
      opts.uploadAttachment ?? (async (_key, filename) => ({ id: 'att-1', filename })),
    resolveRovoInstanceId: () => 'rovo-1',
    siteUrl: opts.siteUrl ?? (async () => 'https://example.atlassian.net')
  }
}

function jobRow(id: number): { post_results: string | null; confirmed_at: string | null } {
  return db.prepare(`SELECT post_results, confirmed_at FROM rca_jobs WHERE id = ?`).get(id) as {
    post_results: string | null
    confirmed_at: string | null
  }
}

describe('postRcaReport', () => {
  it('attachment mode: uploads tech, comments exec, records both outcomes', async () => {
    createCase(db, home, { slug: 'case-a', title: 'Case A', jiraKey: 'PROJ-1' })
    writeArtifacts('case-a', '# exec summary', '# tech detail')
    const jobId = insertJob('case-a')
    const calls: { tool: string; instanceId: string; args: Record<string, unknown> }[] = []

    const res = await postRcaReport(fakeDeps({ techDestination: 'attachment', calls }), 'case-a')

    expect(res.attachment!.ok).toBe(true)
    expect(res.comment!.ok).toBe(true)

    expect(calls).toHaveLength(1) // only the comment goes through callTool in attachment mode
    const commentCall = calls[0]
    expect(commentCall.tool).toBe('addCommentToJiraIssue')
    expect(commentCall.instanceId).toBe('rovo-1')
    expect(commentCall.args.cloudId).toBe('https://example.atlassian.net')
    expect(commentCall.args.issueIdOrKey).toBe('PROJ-1')
    expect(commentCall.args.contentFormat).toBe('markdown')
    expect(String(commentCall.args.commentBody)).toContain('# exec summary')
    // tech target FIRST: the comment references the already-uploaded attachment's filename,
    // which is only possible if the upload ran and resolved before the comment was built.
    expect(String(commentCall.args.commentBody)).toMatch(/rca-case-a\.md/)

    const persisted = jobRow(jobId)
    expect(JSON.parse(persisted.post_results!)).toEqual(res)
  })

  it('confluence mode: creates page first, exec comment links it', async () => {
    createCase(db, home, { slug: 'case-b', title: 'Case B', jiraKey: 'PROJ-2' })
    writeArtifacts('case-b', '# exec summary b', '# tech detail b')
    insertJob('case-b')
    const calls: { tool: string; instanceId: string; args: Record<string, unknown> }[] = []

    const res = await postRcaReport(
      fakeDeps({ techDestination: 'confluence-page', confluenceSpaceKey: 'ENG', calls }),
      'case-b'
    )

    expect(res.confluencePage!.ok).toBe(true)
    expect(res.comment!.ok).toBe(true)

    const pageCall = calls.find((c) => c.tool === 'createConfluencePage')!
    expect(pageCall.args.cloudId).toBe('https://example.atlassian.net')
    expect(pageCall.args.spaceId).toBe('ENG')
    expect(pageCall.args.contentFormat).toBe('markdown')
    expect(pageCall.args.body).toBe('# tech detail b')

    // page created before the comment
    const pageIdx = calls.findIndex((c) => c.tool === 'createConfluencePage')
    const commentIdx = calls.findIndex((c) => c.tool === 'addCommentToJiraIssue')
    expect(pageIdx).toBeLessThan(commentIdx)

    const commentCall = calls[commentIdx]
    expect(String(commentCall.args.commentBody)).toContain(
      'https://example.atlassian.net/wiki/x/ABC123'
    )
  })

  it('partial failure: failed attachment does not block the comment, both recorded', async () => {
    createCase(db, home, { slug: 'case-c', title: 'Case C', jiraKey: 'PROJ-3' })
    writeArtifacts('case-c')
    insertJob('case-c')

    const res = await postRcaReport(
      fakeDeps({
        techDestination: 'attachment',
        uploadAttachment: async () => {
          throw new Error('upload failed: 500')
        }
      }),
      'case-c'
    )

    expect(res.attachment!.ok).toBe(false)
    expect(res.attachment!.error).toContain('upload failed')
    expect(res.comment!.ok).toBe(true)
  })

  it('throws without a linked jira issue', async () => {
    createCase(db, home, { slug: 'case-d', title: 'Case D' })
    writeArtifacts('case-d')
    insertJob('case-d')
    await expect(postRcaReport(fakeDeps(), 'case-d')).rejects.toThrow(/no linked Jira/i)
  })

  it('throws without a confirmed report', async () => {
    createCase(db, home, { slug: 'case-e', title: 'Case E', jiraKey: 'PROJ-5' })
    writeArtifacts('case-e')
    insertJob('case-e', { confirmed: false })
    await expect(postRcaReport(fakeDeps(), 'case-e')).rejects.toThrow(/no confirmed rca report/i)
  })

  it('throws when unknown case', async () => {
    await expect(postRcaReport(fakeDeps(), 'no-such-case')).rejects.toThrow(/unknown case/i)
  })

  it('throws a clear error when the Atlassian site cannot be resolved, before posting anything', async () => {
    createCase(db, home, { slug: 'case-g', title: 'Case G', jiraKey: 'PROJ-7' })
    writeArtifacts('case-g')
    insertJob('case-g')
    const calls: { tool: string; instanceId: string; args: Record<string, unknown> }[] = []
    let uploadCalled = false

    await expect(
      postRcaReport(
        fakeDeps({
          calls,
          siteUrl: async () => null,
          uploadAttachment: async (_key, filename) => {
            uploadCalled = true
            return { id: 'att-1', filename }
          }
        }),
        'case-g'
      )
    ).rejects.toThrow(/atlassian site/i)

    expect(calls).toHaveLength(0) // addCommentToJiraIssue never attempted
    expect(uploadCalled).toBe(false) // neither does the tech-target upload
  })

  it('persists post_results onto the confirmed rca_jobs row, merged across a retry', async () => {
    createCase(db, home, { slug: 'case-f', title: 'Case F', jiraKey: 'PROJ-6' })
    writeArtifacts('case-f')
    const jobId = insertJob('case-f')

    const first = await postRcaReport(fakeDeps({ techDestination: 'attachment' }), 'case-f')
    expect(first.attachment!.ok).toBe(true)
    expect(first.comment!.ok).toBe(true)
    expect(JSON.parse(jobRow(jobId).post_results!)).toEqual(first)

    // Retry with a different tech destination: this call never touches `attachment`, but the
    // prior attachment record must survive the merge (same confirmed job row, not a new one).
    const second = await postRcaReport(
      fakeDeps({ techDestination: 'confluence-page', confluenceSpaceKey: 'ENG' }),
      'case-f'
    )
    expect(second.confluencePage!.ok).toBe(true)
    expect(second.attachment).toEqual(first.attachment)

    const persisted = jobRow(jobId)
    const parsed = JSON.parse(persisted.post_results!)
    expect(parsed.attachment).toEqual(first.attachment)
    expect(parsed.confluencePage.ok).toBe(true)
    expect(parsed.comment.ok).toBe(true)

    // still exactly one job row for this case (both calls landed on the same confirmed job)
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM rca_jobs WHERE case_slug = ?`)
      .get('case-f') as {
      n: number
    }
    expect(count.n).toBe(1)
  })

  it('same-target retry: a FAILED prior record IS retried (only ok:true skips)', async () => {
    createCase(db, home, { slug: 'case-h', title: 'Case H', jiraKey: 'PROJ-8' })
    writeArtifacts('case-h')
    const jobId = insertJob('case-h')

    let uploadCalls = 0
    const first = await postRcaReport(
      fakeDeps({
        techDestination: 'attachment',
        uploadAttachment: async () => {
          uploadCalls++
          throw new Error('upload failed: 500')
        }
      }),
      'case-h'
    )
    expect(first.attachment!.ok).toBe(false)
    expect(uploadCalls).toBe(1)

    // Retry: the prior attachment record is ok:false, so — unlike an ok:true record — it MUST
    // be re-attempted. This time the upload succeeds, overwriting the failed record. (A skipped
    // attempt could never flip ok:false → ok:true, so this alone proves the retry happened.)
    const second = await postRcaReport(fakeDeps({ techDestination: 'attachment' }), 'case-h')

    expect(second.attachment!.ok).toBe(true)
    expect(second.comment!.ok).toBe(true)

    const persisted = JSON.parse(jobRow(jobId).post_results!)
    expect(persisted.attachment.ok).toBe(true)
    expect(persisted.comment.ok).toBe(true)
  })

  it('retry after partial failure: the already-succeeded comment is NOT re-posted; the failed attachment IS retried', async () => {
    createCase(db, home, { slug: 'case-i', title: 'Case I', jiraKey: 'PROJ-9' })
    writeArtifacts('case-i')
    const jobId = insertJob('case-i')

    const first = await postRcaReport(
      fakeDeps({
        techDestination: 'attachment',
        uploadAttachment: async () => {
          throw new Error('upload failed: 500')
        }
      }),
      'case-i'
    )
    expect(first.attachment!.ok).toBe(false)
    expect(first.comment!.ok).toBe(true)

    const calls: { tool: string; instanceId: string; args: Record<string, unknown> }[] = []
    let uploadCalled = false
    const second = await postRcaReport(
      fakeDeps({
        techDestination: 'attachment',
        calls,
        uploadAttachment: async (_key, filename) => {
          uploadCalled = true
          return { id: 'att-2', filename }
        }
      }),
      'case-i'
    )

    expect(uploadCalled).toBe(true) // the failed attachment WAS retried
    expect(second.attachment!.ok).toBe(true)
    // addCommentToJiraIssue is the only callTool use in attachment mode — zero calls here means
    // the already-succeeded comment was not re-posted.
    expect(calls).toHaveLength(0)
    expect(second.comment).toEqual(first.comment) // kept as-is, unchanged from the first call

    const persisted = JSON.parse(jobRow(jobId).post_results!)
    expect(persisted.attachment.ok).toBe(true)
    expect(persisted.comment).toEqual(first.comment)
  })

  it('retry after full success: nothing is re-attempted and results are unchanged', async () => {
    createCase(db, home, { slug: 'case-j', title: 'Case J', jiraKey: 'PROJ-10' })
    writeArtifacts('case-j')
    const jobId = insertJob('case-j')

    const first = await postRcaReport(fakeDeps({ techDestination: 'attachment' }), 'case-j')
    expect(first.attachment!.ok).toBe(true)
    expect(first.comment!.ok).toBe(true)

    const calls: { tool: string; instanceId: string; args: Record<string, unknown> }[] = []
    let uploadCalled = false
    const second = await postRcaReport(
      fakeDeps({
        techDestination: 'attachment',
        calls,
        uploadAttachment: async () => {
          uploadCalled = true
          return { id: 'should-not-happen', filename: 'x' }
        }
      }),
      'case-j'
    )

    expect(uploadCalled).toBe(false) // attachment already ok:true — not re-attempted
    expect(calls).toHaveLength(0) // comment already ok:true — not re-attempted
    expect(second).toEqual(first)

    const persisted = JSON.parse(jobRow(jobId).post_results!)
    expect(persisted).toEqual(first)
  })
})
