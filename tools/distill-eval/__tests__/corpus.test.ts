import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadCorpus } from '../src/corpus'

const LINE = {
  job: {
    id: 1, caseSlug: 'nav-1', promptHash: 'abc123def456', createdAt: 'x',
    state: 'done', inputSnapshot: { caseMeta: { slug: 'nav-1' } }, rawOutput: '```json\n{}\n```', error: null
  },
  items: [], exportedAt: 'x', argusVersion: '1.0.0'
}

function write(content: string): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'distill-eval-')), 'c.ndjson')
  fs.writeFileSync(f, content)
  return f
}

describe('loadCorpus', () => {
  it('parses one line per job and skips blank lines', () => {
    const lines = loadCorpus(write(JSON.stringify(LINE) + '\n\n' + JSON.stringify({ ...LINE, job: { ...LINE.job, id: 2 } }) + '\n'))
    expect(lines.map((l) => l.job.id)).toEqual([1, 2])
  })

  it('names the failing line number on bad JSON', () => {
    expect(() => loadCorpus(write(JSON.stringify(LINE) + '\nnot json\n'))).toThrow(/line 2/)
  })

  it('names the failing line number on a line missing inputSnapshot', () => {
    const bad = { ...LINE, job: { ...LINE.job, inputSnapshot: undefined } }
    expect(() => loadCorpus(write(JSON.stringify(bad)))).toThrow(/line 1/)
  })
})
