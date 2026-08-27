import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { artifactsDir } from '../paths'
import { postRcaToGithub } from '../rca/postGithub'

let home: string
let db: DatabaseSync
let posted: { ref: string; markdown: string }[]

const provider = {
  id: 'github' as const,
  getIssue: async () => {
    throw new Error('unused')
  },
  getComments: async () => [],
  postComment: async (ref: string, markdown: string) => {
    posted.push({ ref, markdown })
    return { url: 'https://github.com/cli/cli/issues/14189#issuecomment-1' }
  },
  webUrl: (r: string) => r,
  linkedPrs: async () => []
}

const deps = (): Parameters<typeof postRcaToGithub>[0] => ({
  db,
  argusHome: home,
  settings: () =>
    ({ watermark: { github: { enabled: true, text: 'Drafted with Argus.' } } }) as never,
  provider
})

beforeEach(() => {
  posted = []
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, {
    slug: 'cli-14189',
    title: 'Tiles 403',
    jiraKey: 'cli/cli#14189',
    ticketProvider: 'github'
  })
  const dir = artifactsDir(home, 'cli-14189')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'rca-exec.md'), '## Summary\n\nTiles 403 under load.')
  fs.writeFileSync(path.join(dir, 'rca-tech.md'), '## Trace\n\nfull technical detail')
  db.prepare(
    `INSERT INTO rca_jobs (case_slug, state, input_snapshot, confirmed_at, created_at)
     VALUES (?, 'done', '{}', ?, ?)`
  ).run('cli-14189', new Date().toISOString(), new Date().toISOString())
})

describe('postRcaToGithub', () => {
  it('posts exactly one comment carrying exec prose and the technical report', async () => {
    const results = await postRcaToGithub(deps(), 'cli-14189')
    expect(results.comment?.ok).toBe(true)
    expect(posted).toHaveLength(1)
    expect(posted[0].ref).toBe('cli/cli#14189')
    expect(posted[0].markdown).toContain('Tiles 403 under load.')
    expect(posted[0].markdown).toContain('<details>')
    expect(posted[0].markdown).toContain('full technical detail')
  })

  it('puts the watermark last, as the comment footer', async () => {
    await postRcaToGithub(deps(), 'cli-14189')
    expect(posted[0].markdown.trimEnd().endsWith('Drafted with Argus.')).toBe(true)
  })

  it('does not re-post a comment already recorded ok', async () => {
    await postRcaToGithub(deps(), 'cli-14189')
    const again = await postRcaToGithub(deps(), 'cli-14189')
    expect(posted).toHaveLength(1)
    expect(again.comment?.ok).toBe(true)
  })

  it('records a failure without throwing', async () => {
    const failing = {
      ...deps(),
      provider: {
        ...provider,
        postComment: async () => {
          throw new Error('gh: 403 Forbidden')
        }
      }
    }
    const results = await postRcaToGithub(failing, 'cli-14189')
    expect(results.comment?.ok).toBe(false)
    expect(results.comment?.error).toMatch(/403/)
  })
})
