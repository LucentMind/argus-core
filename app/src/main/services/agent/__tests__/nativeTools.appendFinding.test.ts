import { it, expect, beforeEach, afterEach, describe, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { caseDir } from '../../paths'
import { createDetection } from '../../packs/detection'
import { addBinding } from '../../prBindings'
import { casePrWorktreeDir } from '../../prWorktree'
import { appendFinding, argusToolHandlers, type FindingWriteCtx } from '../nativeTools'
import type { GitRunner } from '../reviewWrites'

let home: string, db: DatabaseSync, ctx: FindingWriteCtx

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-finding-'))
  db = openDb(path.join(home, 'argus.db'))
  const c = createCase(db, home, { slug: 'CASE-A', title: 'A' })
  ctx = { db, argusHome: home, caseId: c.id, caseSlug: 'CASE-A', sessionId: 5, turnId: null }
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

it('appends a findings.md block and inserts a pending findings row', () => {
  const { findingId, block } = appendFinding(ctx, {
    title: 'Race in tile cache',
    markdown: 'See [evidence/log.txt:12]'
  })
  expect(findingId).toBeGreaterThan(0)
  expect(block).toContain('## Race in tile cache')
  expect(fs.readFileSync(path.join(caseDir(home, 'CASE-A'), 'findings.md'), 'utf8')).toContain(
    'Race in tile cache'
  )
  const row = db
    .prepare('SELECT summary, review_state FROM findings WHERE id = ?')
    .get(findingId) as { summary: string; review_state: string } | undefined
  expect(row).toEqual({ summary: 'Race in tile cache', review_state: 'pending' })
})

it('embeds a <!-- finding:{id} --> marker whose id matches the inserted row', () => {
  const { findingId, block } = appendFinding(ctx, {
    title: 'Null deref in tile',
    markdown: 'body text'
  })
  expect(block).toContain(`<!-- finding:${findingId} -->`)
  const md = fs.readFileSync(path.join(caseDir(home, 'CASE-A'), 'findings.md'), 'utf8')
  expect(md).toContain(`<!-- finding:${findingId} -->`)
  // marker precedes the heading in the file
  expect(md.indexOf(`<!-- finding:${findingId} -->`)).toBeLessThan(
    md.indexOf('## Null deref in tile')
  )
})

it('persists layer and severity when given', () => {
  const { findingId } = appendFinding(ctx, {
    title: 'Inverted guard',
    markdown: 'Fails when n is 0. [repo/a.ts:42]',
    layer: 'correctness',
    severity: 'major'
  })
  const row = ctx.db
    .prepare(`SELECT layer, severity, diff_path, diff_line FROM findings WHERE id = ?`)
    .get(findingId) as { layer: string; severity: string; diff_path: string; diff_line: number }
  expect(row).toEqual({
    layer: 'correctness',
    severity: 'major',
    diff_path: 'repo/a.ts',
    diff_line: 42
  })
})

it('leaves the flavor null for an investigation finding', () => {
  const { findingId } = appendFinding(ctx, { title: 'Root cause', markdown: 'No citation.' })
  const row = ctx.db
    .prepare(`SELECT layer, severity, diff_path, diff_line FROM findings WHERE id = ?`)
    .get(findingId) as Record<string, unknown>
  expect(row).toEqual({ layer: null, severity: null, diff_path: null, diff_line: null })
})

it('rejects an unknown layer instead of persisting it', () => {
  expect(() => appendFinding(ctx, { title: 't', markdown: 'm', layer: 'vibes' as never })).toThrow(
    /vibes/
  )
  expect((ctx.db.prepare(`SELECT COUNT(*) AS n FROM findings`).get() as { n: number }).n).toBe(0)
})

it('rejects an unknown severity instead of persisting it', () => {
  expect(() => appendFinding(ctx, { title: 't', markdown: 'm', severity: 'nit' as never })).toThrow(
    /nit/
  )
  expect((ctx.db.prepare(`SELECT COUNT(*) AS n FROM findings`).get() as { n: number }).n).toBe(0)
})

it('routes the bad-layer error through ctx.resolve so an override actually bites', () => {
  const overridden = 'CUSTOM OVERRIDE: layer {layer} not in {expected}'
  const resolvingCtx: FindingWriteCtx = {
    ...ctx,
    resolve: (id) => (id === 'tool-feedback.append_finding.bad-layer' ? overridden : id)
  }
  expect(() =>
    appendFinding(resolvingCtx, { title: 't', markdown: 'm', layer: 'vibes' as never })
  ).toThrow(/CUSTOM OVERRIDE: layer "vibes" not in/)
})

describe('append_finding via argusToolHandlers records comment_body and head_sha', () => {
  let ntHome: string
  let ntDb: DatabaseSync
  const detection = createDetection()
  const emitFinding = vi.fn()

  beforeEach(() => {
    ntHome = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-af-comment-'))
    ntDb = openDb(path.join(ntHome, 'argus.db'))
    createCase(ntDb, ntHome, { slug: 'c1', title: 'Case 1' })
  })
  afterEach(() => {
    ntDb.close()
    fs.rmSync(ntHome, { recursive: true, force: true })
  })

  function makeHandlers(git?: GitRunner): ReturnType<typeof argusToolHandlers> {
    return argusToolHandlers({
      db: ntDb,
      argusHome: ntHome,
      detection,
      caseId: getCase(ntDb, 'c1')!.id,
      caseSlug: 'c1',
      sessionId: 1,
      emitFinding,
      git
    })
  }

  it('stores comment_body on the findings row', async () => {
    const handlers = makeHandlers()
    await handlers.append_finding({
      title: 'T',
      markdown: 'body [Repo/src/a.ts:3]',
      layer: 'correctness',
      severity: 'major',
      comment_body: 'This breaks when the input is empty.'
    })
    const row = ntDb
      .prepare(`SELECT comment_body FROM findings ORDER BY id DESC LIMIT 1`)
      .get() as {
      comment_body: string | null
    }
    expect(row.comment_body).toBe('This breaks when the input is empty.')
  })

  it('stamps head_sha from the PR worktree HEAD when a binding + worktree exist', async () => {
    // deps.git is the injected GitRunner; the fake returns a fixed sha for rev-parse HEAD
    const fakeGit: GitRunner = async (_cwd, args) => {
      if (args[0] === 'rev-parse') return 'feedbeefcafe'
      throw new Error(`unexpected git ${args.join(' ')}`)
    }
    const repoPath = path.join(ntHome, 'clones', 'widget')
    fs.mkdirSync(repoPath, { recursive: true })
    addBinding(ntDb, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    const worktree = casePrWorktreeDir(ntHome, 'c1', repoPath, 42)
    fs.mkdirSync(worktree, { recursive: true })

    const handlers = makeHandlers(fakeGit)
    await handlers.append_finding({ title: 'T', markdown: 'body [Repo/src/a.ts:3]' })
    const row = ntDb.prepare(`SELECT head_sha FROM findings ORDER BY id DESC LIMIT 1`).get() as {
      head_sha: string | null
    }
    expect(row.head_sha).toBe('feedbeefcafe')
  })

  it('leaves head_sha null when the case has no PR binding', async () => {
    const handlers = makeHandlers()
    await handlers.append_finding({ title: 'T', markdown: 'body' })
    const row = ntDb.prepare(`SELECT head_sha FROM findings ORDER BY id DESC LIMIT 1`).get() as {
      head_sha: string | null
    }
    expect(row.head_sha).toBeNull()
  })
})
