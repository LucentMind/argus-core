import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, setCaseStatus } from '../../caseService'
import { listProposals, acceptProposal } from '../../proposals'
import { getCaseSummary } from '../summaries'
import { assembleDistillInput } from '../input'
import { runCaseDistill } from '../caseDistiller'
import { stageDistillOutput } from '../staging'
import { DistillQueue } from '../queue'

const RESPONSE =
  '```json\n' +
  JSON.stringify({
    summary: {
      signature: 'ECU reset drifts DLT',
      symptoms: 'sy',
      rootCause: 'rc',
      fix: 'fx',
      keywords: ['dlt']
    },
    memoryAppends: [
      { topic: 'dlt-timing', content: 'ECU resets drift DLT clocks.', indexEntry: 'DLT drift' }
    ]
  }) +
  '\n```'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'case-a', title: 'DLT drift after reset' })
})

it('close → enqueue → distill → stage → accept lands memory + summary', async () => {
  const queue = new DistillQueue({
    db,
    assembleInput: (slug) => assembleDistillInput(db, home, slug),
    distill: (input) => runCaseDistill(input, async () => RESPONSE),
    stage: (slug, jobId, output) => stageDistillOutput(db, home, slug, jobId, output),
    broadcast: () => undefined
  })
  setCaseStatus(db, home, 'case-a', 'closed', 'solved', (rec) => queue.enqueue(rec.slug))
  await queue.idle()
  expect(queue.statusFor('case-a')).toMatchObject({ state: 'done', itemCount: 2 })

  const staged = listProposals(home)
  expect(staged.map((p) => p.type).sort()).toEqual(['case-summary', 'memory-append'])
  for (const p of staged) acceptProposal(home, p.file, { db })

  expect(fs.readFileSync(path.join(home, 'memory', 'dlt-timing.md'), 'utf8')).toContain(
    'drift DLT clocks'
  )
  expect(getCaseSummary(db, 'case-a')).toMatchObject({
    signature: 'ECU reset drifts DLT',
    resolution: 'solved'
  })
  expect(fs.existsSync(path.join(home, 'cases', 'case-a', 'summary.md'))).toBe(true)
})
