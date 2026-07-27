import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { createDetection } from '../../packs/detection'
import { addBinding } from '../../prBindings'
import { casePrWorktreeDir } from '../../prWorktree'
import { listFindings } from '../../findings'
import { argusToolHandlers, appendFinding, NATIVE_TOOL_SPECS } from '../nativeTools'
import { NATIVE_RISK } from '../risk'
import { isEditableTool } from '../../../../shared/editableTools'
import type { Runner } from '../../github'

const spec = (name: string): (typeof NATIVE_TOOL_SPECS)[number] | undefined =>
  NATIVE_TOOL_SPECS.find((s) => s.name === name)

describe('review write tool registration', () => {
  it('registers both write tools', () => {
    expect(spec('post_review_comment')).toBeDefined()
    expect(spec('push_review_change')).toBeDefined()
  })

  it('gates the comment at MEDIUM and the push at HIGH, neither grantable for the session', () => {
    expect(NATIVE_RISK['mcp__argus__post_review_comment']).toMatchObject({
      action: 'ask',
      risk: 'MEDIUM',
      grantKey: null
    })
    expect(NATIVE_RISK['mcp__argus__push_review_change']).toMatchObject({
      action: 'ask',
      risk: 'HIGH',
      grantKey: null
    })
  })

  it('makes only the comment body editable', () => {
    expect(isEditableTool('mcp__argus__post_review_comment')).toBe(true)
    expect(isEditableTool('mcp__argus__push_review_change')).toBe(false)
  })
})

/**
 * Task 4 review finding: no test drove either write tool through argusToolHandlers — the
 * existing coverage calls postReviewComment/pushReviewChange directly (reviewWrites.*.test.ts),
 * skipping the handler layer entirely. That layer has real logic worth pinning: the
 * Number(args.finding_id) / String(args.body ?? '') coercions, the `deps.gh ?? defaultGhRunner`
 * fallback, and the `deps.emitFindingUpdated?.(findingId)` call — which would silently never
 * fire if it were dropped. Follows the append_finding handler test's setup style
 * (nativeTools.test.ts) plus the PR-binding/worktree fixtures from reviewWrites.*.test.ts.
 */
describe('review write tools via argusToolHandlers', () => {
  let db: DatabaseSync
  let home: string
  let repoPath: string
  let worktree: string
  const detection = createDetection()
  const emitFinding = vi.fn()

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-nt-revwrites-'))
    db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'c1', title: 'Case 1' })
    repoPath = path.join(home, 'clones', 'widget')
    fs.mkdirSync(repoPath, { recursive: true })
    // `updated_at` is NOT NULL with no default (db.ts:50) — omitting it fails the insert.
    const nowIso = new Date().toISOString()
    db.prepare(
      `INSERT INTO sessions (id, case_id, mode, created_at, updated_at) VALUES (1, ?, 'review', ?, ?)`
    ).run(getCase(db, 'c1')!.id, nowIso, nowIso)
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    worktree = casePrWorktreeDir(home, 'c1', repoPath, 42)
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true })
    fs.writeFileSync(path.join(worktree, 'src', 'guard.ts'), 'x')
  })

  function seedFinding(): number {
    return appendFinding(
      {
        db,
        argusHome: home,
        caseId: getCase(db, 'c1')!.id,
        caseSlug: 'c1',
        sessionId: 1,
        turnId: null
      },
      {
        title: 'Inverted guard',
        markdown: 'Inverted. See [widget/src/guard.ts:17].',
        layer: 'correctness',
        severity: 'major'
      }
    ).findingId
  }

  it('post_review_comment coerces finding_id/body, posts via the injected gh, and notifies the listener', async () => {
    const calls: string[][] = []
    const gh: Runner = async (_cmd, args) => {
      calls.push(args)
      if (args[0] === 'pr')
        return JSON.stringify({
          headRefName: 'feature/guard',
          headRefOid: 'abc123',
          isCrossRepository: false
        })
      return JSON.stringify({ html_url: 'https://github.com/acme/widget/pull/42#discussion_r1' })
    }
    const emitFindingUpdated = vi.fn()
    const handlers = argusToolHandlers({
      db,
      argusHome: home,
      detection,
      caseId: getCase(db, 'c1')!.id,
      caseSlug: 'c1',
      sessionId: 1,
      emitFinding,
      gh,
      emitFindingUpdated
    })
    const id = seedFinding()
    // finding_id arrives as a string (as it would off the wire) to pin Number(args.finding_id);
    // body is omitted to pin the String(args.body ?? '') fallback to an empty string.
    const out = await handlers.post_review_comment({ finding_id: String(id) })
    expect(out).toContain('https://github.com/acme/widget/pull/42#discussion_r1')
    expect(emitFindingUpdated).toHaveBeenCalledOnce()
    expect(emitFindingUpdated).toHaveBeenCalledWith(id)
    const inlineCall = calls.find((c) => c.includes('-F'))
    expect(inlineCall).toContain('body=')
    const row = listFindings(db, home, 'c1').find((f) => f.id === id)
    expect(row?.commentUrl).toBe('https://github.com/acme/widget/pull/42#discussion_r1')
  })

  it('push_review_change coerces finding_id, commits+pushes to a real remote, and notifies the listener', async () => {
    const origin = path.join(home, 'origin.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', origin])
    const seed = path.join(home, 'seed')
    execFileSync('git', ['clone', origin, seed])
    const g = (...args: string[]): void => {
      execFileSync('git', args, { cwd: seed })
    }
    fs.writeFileSync(path.join(seed, 'file.txt'), 'one\n')
    g('add', '-A')
    g('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'seed')
    g('push', 'origin', 'main:refs/heads/feature/guard')
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seed }).toString().trim()

    fs.rmSync(worktree, { recursive: true, force: true })
    execFileSync('git', ['clone', origin, worktree])
    execFileSync('git', ['switch', '--detach', 'origin/feature/guard'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: worktree })
    fs.writeFileSync(path.join(worktree, 'file.txt'), 'two\n')

    const gh: Runner = async () =>
      JSON.stringify({
        headRefName: 'feature/guard',
        headRefOid: baseSha,
        isCrossRepository: false
      })
    const emitFindingUpdated = vi.fn()
    const handlers = argusToolHandlers({
      db,
      argusHome: home,
      detection,
      caseId: getCase(db, 'c1')!.id,
      caseSlug: 'c1',
      sessionId: 1,
      emitFinding,
      gh,
      emitFindingUpdated
    })
    const id = seedFinding()
    // finding_id arrives as a string to pin Number(args.finding_id); commit_message is real
    // since `git commit -m ''` fails, unlike the comment tool's body it cannot be exercised empty.
    const out = await handlers.push_review_change({
      finding_id: String(id),
      commit_message: 'fix: flip the inverted guard'
    })
    expect(out).toContain('feature/guard')
    expect(emitFindingUpdated).toHaveBeenCalledOnce()
    expect(emitFindingUpdated).toHaveBeenCalledWith(id)
    const remoteLog = execFileSync(
      'git',
      ['log', '-1', '--format=%s', 'refs/heads/feature/guard'],
      { cwd: origin }
    )
      .toString()
      .trim()
    expect(remoteLog).toBe('fix: flip the inverted guard')
    const row = listFindings(db, home, 'c1').find((f) => f.id === id)
    expect(row?.pushedSha).toHaveLength(40)
  }, 30_000)
})
