import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { addBinding } from '../../prBindings'
import { casePrWorktreeDir } from '../../prWorktree'
import { AgentService } from '../registry'
import { createSession } from '../sessionStore'
import { appendFinding } from '../nativeTools'
import { AsyncQueue } from '../asyncQueue'
import { defaultAgentAccess } from '../../../../shared/agentAccess'
import { createDetection } from '../../packs/detection'
import type { CreateQueryFn } from '../drivers/claude'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { Runner } from '../../github'

const detection = createDetection()
let home: string, db: DatabaseSync, events: AgentEvent[]
let repoPath: string, worktree: string
let postedBodies: string[]
let gh: Runner

const fakeCreateQuery = (): CreateQueryFn => () => {
  const q = new AsyncQueue<unknown>()
  return Object.assign(
    { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
    { interrupt: async () => q.end() }
  )
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pfc-'))
  db = openDb(path.join(home, 'argus.db'))
  events = []
  postedBodies = []
  createCase(db, home, { slug: 'NAV-1', title: 'NAV-1' })
  repoPath = path.join(home, 'clones', 'widget')
  fs.mkdirSync(repoPath, { recursive: true })
  addBinding(db, 'NAV-1', {
    repoPath,
    owner: 'acme',
    repo: 'widget',
    number: 42,
    url: 'https://github.com/acme/widget/pull/42',
    source: 'manual'
  })
  worktree = casePrWorktreeDir(home, 'NAV-1', repoPath, 42)
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true })
  fs.writeFileSync(path.join(worktree, 'src', 'guard.ts'), 'x')
  gh = async (_cmd, args) => {
    if (args[0] === 'pr') {
      return JSON.stringify({
        headRefName: 'feature',
        headRefOid: 'currenthead000',
        isCrossRepository: false
      })
    }
    postedBodies.push(bodyFromArgs(args))
    return JSON.stringify({ html_url: 'https://github.com/acme/widget/pull/42#discussion_r1' })
  }
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

/** Pull the `-F body=<text>` field the fake gh runner is invoked with (inline comment post). */
function bodyFromArgs(args: string[]): string {
  const f = args.find((a) => a.startsWith('body='))
  return f ? f.slice('body='.length) : ''
}

const mkService = (): AgentService =>
  new AgentService({
    db,
    argusHome: home,
    detection,
    skillsRoots: [],
    agentAccess: () => defaultAgentAccess(),
    onEvent: (e) => events.push(e),
    createQuery: fakeCreateQuery(),
    gh
  })

function seedFinding(opts: { commentBody?: string | null; headSha?: string | null }): number {
  const { findingId } = appendFinding(
    {
      db,
      argusHome: home,
      caseId: getCase(db, 'NAV-1')!.id,
      caseSlug: 'NAV-1',
      sessionId: 1,
      turnId: null
    },
    {
      title: 'Inverted guard',
      markdown: 'Inverted. See [widget/src/guard.ts:17].',
      layer: 'correctness',
      severity: 'major',
      ...(opts.commentBody != null ? { commentBody: opts.commentBody } : {}),
      ...(opts.headSha != null ? { headSha: opts.headSha } : {})
    }
  )
  return findingId
}

it('raises an editable MEDIUM card carrying the stored comment_body, then posts on approve', async () => {
  const svc = mkService()
  const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
  const findingId = seedFinding({ commentBody: 'Stored prose.', headSha: 'currenthead000' })

  const p = svc.postFindingComment('NAV-1', s.id, findingId)
  await new Promise((r) => setTimeout(r, 5))
  const opened = events.find((e) => e.type === 'request.opened')!
  expect(opened.payload.tool).toBe('mcp__argus__post_review_comment')
  expect(opened.payload.risk).toBe('MEDIUM')
  expect(opened.payload.input).toMatchObject({ finding_id: findingId, body: 'Stored prose.' })

  svc.respond('NAV-1', s.id, {
    requestId: opened.payload.requestId,
    kind: 'allow',
    updatedInput: { ...opened.payload.input, body: 'Edited prose.' }
  })
  expect(await p).toEqual({ ok: true })
  expect(postedBodies).toEqual(['Edited prose.'])
  const row = db.prepare(`SELECT comment_url FROM findings WHERE id = ?`).get(findingId) as {
    comment_url: string | null
  }
  expect(row.comment_url).toContain('github.com')
  await svc.stopAll()
})

it('reports no-body without raising a card when comment_body is null', async () => {
  const svc = mkService()
  const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
  const bareFindingId = seedFinding({})

  expect(await svc.postFindingComment('NAV-1', s.id, bareFindingId)).toEqual({
    ok: false,
    reason: 'no-body'
  })
  expect(events.find((e) => e.type === 'request.opened')).toBeUndefined()
  await svc.stopAll()
})

it('flags a stale finding on the card input', async () => {
  const svc = mkService()
  const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
  const staleFindingId = seedFinding({ commentBody: 'Stored prose.', headSha: 'oldhead0000000' })

  const p = svc.postFindingComment('NAV-1', s.id, staleFindingId)
  await new Promise((r) => setTimeout(r, 5))
  const opened = events.find((e) => e.type === 'request.opened')!
  expect((opened.payload.input as Record<string, unknown>).pr_advanced).toEqual({
    recorded: 'oldhead00000',
    now: 'currenthead0'
  })
  svc.respond('NAV-1', s.id, { requestId: opened.payload.requestId, kind: 'deny' })
  expect(await p).toEqual({ ok: false, reason: 'denied' })
  await svc.stopAll()
})

it('posts nothing on deny', async () => {
  const svc = mkService()
  const s = createSession(db, 'NAV-1', 'claude-agent-sdk')
  const findingId = seedFinding({ commentBody: 'Stored prose.', headSha: 'currenthead000' })

  const p = svc.postFindingComment('NAV-1', s.id, findingId)
  await new Promise((r) => setTimeout(r, 5))
  const opened = events.find((e) => e.type === 'request.opened')!
  svc.respond('NAV-1', s.id, { requestId: opened.payload.requestId, kind: 'deny' })
  expect(await p).toEqual({ ok: false, reason: 'denied' })
  expect(postedBodies).toEqual([])
  await svc.stopAll()
})
