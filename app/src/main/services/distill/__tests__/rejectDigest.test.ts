import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildRejectStats,
  rebuildRejectDigest,
  readRejectDigest,
  digestStale,
  DIGEST_MAX_BULLETS,
  DIGEST_MAX_CHARS,
  DIGEST_TRIGGER_NEW_REJECTS,
  DIGEST_PROMPT
} from '../rejectDigest'
import { listArchivedProposals } from '../../proposals'
import { proposalsArchiveDir } from '../../paths'
import type { HeadlessResult } from '../../agent/driver'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
})

/** Writes an archived-proposal file directly, matching the frontmatter shape
 *  `listArchivedProposals` parses (status/type/target/case/date/reject_reason/reject_note). */
function archiveReject(
  home: string,
  name: string,
  fields: { type: string; target: string; tag: string; note?: string; date?: string }
): void {
  const dir = proposalsArchiveDir(home)
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    '---',
    `type: ${fields.type}`,
    `target: ${fields.target}`,
    'case: case-a',
    `date: ${fields.date ?? '2026-01-01T00:00:00.000Z'}`,
    'title: T',
    'status: rejected',
    `reject_reason: ${fields.tag}`,
    ...(fields.note ? [`reject_note: ${fields.note}`] : []),
    `rejected_at: ${fields.date ?? '2026-01-01T00:00:00.000Z'}`,
    '---',
    'body'
  ]
  fs.writeFileSync(path.join(dir, `${name}.md`), lines.join('\n'))
}

describe('buildRejectStats', () => {
  it('golden: 2x overgeneric/reference-edit, 1x overfit/skill-new-with-note → counts by tag and type, notes verbatim', () => {
    const rejects = [
      { type: 'reference-edit', rejectReason: 'overgeneric' },
      { type: 'reference-edit', rejectReason: 'overgeneric' },
      {
        type: 'skill-new',
        rejectReason: 'overfit',
        rejectNote: 'copied case-specific env var name'
      }
    ] as unknown as ReturnType<typeof listArchivedProposals>
    const out = buildRejectStats(rejects)
    expect(out).toBe(
      [
        'Total rejected proposals analyzed: 3',
        '',
        'By reject reason:',
        '- overgeneric: 2',
        '- overfit: 1',
        '',
        'By proposal type:',
        '- reference-edit: 2',
        '- skill-new: 1',
        '',
        'Reviewer notes:',
        '- overfit skill-new: copied case-specific env var name'
      ].join('\n')
    )
  })

  it('no notes → no "Reviewer notes" section at all', () => {
    const rejects = [{ type: 'recipe', rejectReason: 'wrong' }] as unknown as ReturnType<
      typeof listArchivedProposals
    >
    expect(buildRejectStats(rejects)).not.toContain('Reviewer notes')
  })

  it('empty input is handled without throwing', () => {
    expect(buildRejectStats([])).toContain('Total rejected proposals analyzed: 0')
  })
})

describe('rebuildRejectDigest', () => {
  it('writes the file with LLM text truncated to DIGEST_MAX_BULLETS lines and DIGEST_MAX_CHARS chars — never trusted to the model', async () => {
    archiveReject(home, 'a', { type: 'reference-edit', target: 'foo', tag: 'overgeneric' })
    const longLine = '- '.padEnd(200, 'x')
    // 12 bullet lines (over the 8 cap) each long enough that, combined, they also blow the char cap.
    const bullets = Array.from({ length: 12 }, () => longLine).join('\n')
    const run = async (): Promise<HeadlessResult> => ({
      text: `preamble the model added\n${bullets}\ntrailer`
    })
    await rebuildRejectDigest(home, run, 1, 42)
    const digest = readRejectDigest(home)!
    const lines = digest.text.split('\n')
    expect(lines.length).toBeLessThanOrEqual(DIGEST_MAX_BULLETS)
    expect(lines.every((l) => l.startsWith('- '))).toBe(true)
    expect(digest.text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
    expect(digest.rejectCount).toBe(1)
    expect(digest.builtAt).toBeTruthy()
    const raw = fs.readFileSync(path.join(home, 'proposals', 'reject-patterns.md'), 'utf8')
    expect(raw).toMatch(/^---\nbuilt_at: .+\nreject_count: 1\njob: 42\n---\n/)
  })

  it('sends the verbatim prompt prefix followed by the stats block', async () => {
    archiveReject(home, 'a', { type: 'reference-edit', target: 'foo', tag: 'overgeneric' })
    let seenPrompt = ''
    const run = async (prompt: string): Promise<HeadlessResult> => {
      seenPrompt = prompt
      return { text: '- do the thing' }
    }
    await rebuildRejectDigest(home, run, 1)
    expect(seenPrompt.startsWith(DIGEST_PROMPT)).toBe(true)
    expect(seenPrompt).toContain('Total rejected proposals analyzed: 1')
  })

  it('omits the `job` frontmatter key when no jobId is given', async () => {
    const run = async (): Promise<HeadlessResult> => ({ text: '- x' })
    await rebuildRejectDigest(home, run, 0)
    const raw = fs.readFileSync(path.join(home, 'proposals', 'reject-patterns.md'), 'utf8')
    expect(raw).not.toContain('job:')
  })

  it('a bullet-free model response throws instead of writing an empty digest, and leaves an existing file untouched', async () => {
    archiveReject(home, 'a', { type: 'reference-edit', target: 'foo', tag: 'overgeneric' })
    // Seed a real, good digest first.
    await rebuildRejectDigest(home, async () => ({ text: '- a good bullet' }), 1)
    const before = readRejectDigest(home)!
    expect(before.text).toBe('- a good bullet')

    const noBullets = async (): Promise<HeadlessResult> => ({
      text: 'sure, here is my analysis: nothing structured, no dashes at all'
    })
    await expect(rebuildRejectDigest(home, noBullets, 99)).rejects.toThrow(/no usable bullets/)

    const after = readRejectDigest(home)!
    expect(after.text).toBe('- a good bullet') // untouched
    expect(after.rejectCount).toBe(before.rejectCount) // NOT advanced to 99 by the failed rebuild
  })

  it('a first bullet alone over DIGEST_MAX_CHARS also throws (truncation would otherwise silently produce empty text)', async () => {
    const hugeBullet = `- ${'x'.repeat(DIGEST_MAX_CHARS + 10)}`
    const run = async (): Promise<HeadlessResult> => ({ text: hugeBullet })
    await expect(rebuildRejectDigest(home, run, 0)).rejects.toThrow(/no usable bullets/)
    expect(readRejectDigest(home)).toBeNull() // never built in the first place — still null
  })

  it('bounds the reject window to the most recent DIGEST_REJECT_WINDOW rejects', async () => {
    for (let i = 0; i < 55; i++) {
      archiveReject(home, `r${i}`, {
        type: 'recipe',
        target: `t${i}`,
        tag: 'other',
        date: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`
      })
    }
    let seenPrompt = ''
    const run = async (prompt: string): Promise<HeadlessResult> => {
      seenPrompt = prompt
      return { text: '- x' }
    }
    await rebuildRejectDigest(home, run, 55)
    expect(seenPrompt).toContain('Total rejected proposals analyzed: 50')
  })
})

describe('digestStale', () => {
  it('no file + rejects >= DIGEST_TRIGGER_NEW_REJECTS → true', () => {
    expect(digestStale(home, DIGEST_TRIGGER_NEW_REJECTS)).toBe(true)
  })

  it('no file + rejects below the trigger → false', () => {
    expect(digestStale(home, DIGEST_TRIGGER_NEW_REJECTS - 1)).toBe(false)
  })

  it('file with reject_count 10 and 14 total → false (4 new, below trigger)', async () => {
    const run = async (): Promise<HeadlessResult> => ({ text: '- x' })
    await rebuildRejectDigest(home, run, 10)
    expect(digestStale(home, 14)).toBe(false)
  })

  it('file with reject_count 10 and 15 total → true (5 new, at trigger)', async () => {
    const run = async (): Promise<HeadlessResult> => ({ text: '- x' })
    await rebuildRejectDigest(home, run, 10)
    expect(digestStale(home, 15)).toBe(true)
  })
})

describe('readRejectDigest', () => {
  it('null when the file has never been built', () => {
    expect(readRejectDigest(home)).toBeNull()
  })

  it('a missing/malformed reject_count parses as 0, not NaN (NaN would make digestStale permanently false)', () => {
    fs.mkdirSync(path.join(home, 'proposals'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'proposals', 'reject-patterns.md'),
      ['---', 'built_at: 2026-01-01T00:00:00.000Z', '---', '- some bullet\n'].join('\n')
    )
    const digest = readRejectDigest(home)!
    expect(digest.rejectCount).toBe(0)
    expect(Number.isFinite(digest.rejectCount)).toBe(true)
    expect(digestStale(home, DIGEST_TRIGGER_NEW_REJECTS)).toBe(true) // still triggers, not stuck
  })
})

describe('rebuildRejectDigest cancellation', () => {
  it('forwards opts (including signal) through to run(), so a digest job cancel can reach the in-flight LLM call', async () => {
    const ac = new AbortController()
    let seenSignal: AbortSignal | undefined
    const run = async (
      _prompt: string,
      opts?: { signal?: AbortSignal }
    ): Promise<HeadlessResult> => {
      seenSignal = opts?.signal
      return { text: '- x' }
    }
    await rebuildRejectDigest(home, run, 0, undefined, { signal: ac.signal })
    expect(seenSignal).toBe(ac.signal)
  })
})
