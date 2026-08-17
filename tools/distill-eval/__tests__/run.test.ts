import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { runEval } from '../src/run'
import { writeReport } from '../src/report'
import { line } from './fixtures'
import { caseDistillPromptHash } from '../../../app/src/main/services/distill/promptHash'

describe('runEval', () => {
  it('classifies parse transitions and judges reviewed items', async () => {
    const cases = [
      // done job whose replay still parses, with one rejected item to judge:
      { ...line(), items: [{ type: 'skill-new', target: 's', title: 't', outcome: 'rejected' as const, rejectReason: 'overgeneric' }] },
      // previously-failed job whose replay now parses → parse-improved:
      line({ id: 2, state: 'failed', promptHash: 'ffffffffffff', rawOutput: 'NOT JSON', error: 'expected exactly 1 json fence, got 0' })
    ]
    const results = await runEval(cases, {
      agent: async () => '```json\n{}\n```', // candidate agent output (parses)
      oneShot: async () => '```json\n{"verdict": "improved", "reason": "r"}\n```' // judge
    })
    expect(results[0].parseOutcome).toBe('ok')
    expect(results[0].itemVerdicts).toHaveLength(1)
    expect(results[0].itemVerdicts[0].verdict.verdict).toBe('improved')
    expect(results[1].parseOutcome).toBe('parse-improved')
    expect(results[1].itemVerdicts).toEqual([])
  })

  it('candidate parse failure on a done job is parse-regressed; malformed judge output → needs-human', async () => {
    const cases = [
      { ...line(), items: [{ type: 'skill-new', target: 's', title: 't', outcome: 'accepted' as const }] }
    ]
    const regressed = await runEval(cases, { agent: async () => 'garbage', oneShot: async () => '' })
    expect(regressed[0].parseOutcome).toBe('parse-regressed')
    expect(regressed[0].itemVerdicts).toEqual([]) // nothing to judge against garbage

    const flaky = await runEval(cases, {
      agent: async () => '```json\n{}\n```',
      oneShot: async () => 'not a verdict'
    })
    expect(flaky[0].itemVerdicts[0].verdict.verdict).toBe('needs-human')
  })

  it('short-circuits to unchanged without calling the judge when the prompt hash is unchanged (reused baseline)', async () => {
    const cases = [
      {
        ...line({ promptHash: caseDistillPromptHash() }),
        items: [{ type: 'skill-new', target: 's', title: 't', outcome: 'rejected' as const, rejectReason: 'overfit' }]
      }
    ]
    const judgeRun = vi.fn(async () => '```json\n{"verdict": "improved", "reason": "r"}\n```')
    const results = await runEval(cases, {
      agent: async () => 'unused — reused replay skips the candidate run too',
      oneShot: judgeRun
    })
    expect(judgeRun).not.toHaveBeenCalled()
    expect(results[0].itemVerdicts).toHaveLength(1)
    expect(results[0].itemVerdicts[0].verdict).toEqual({
      verdict: 'unchanged',
      reason: 'prompt unchanged — baseline output reused'
    })
  })
})

describe('writeReport', () => {
  it('writes report.md (needs-human first) and details.jsonl', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-eval-out-'))
    const results = await runEval(
      [{ ...line(), items: [{ type: 'skill-new', target: 's', title: 't', outcome: 'rejected' as const, rejectReason: 'overfit' }] }],
      { agent: async () => '```json\n{}\n```', oneShot: async () => 'malformed judge' }
    )
    const { reportPath, detailsPath } = writeReport(out, results)
    const md = fs.readFileSync(reportPath, 'utf8')
    expect(md).toContain('needs-human')
    expect(md).toContain('overfit')
    expect(fs.readFileSync(detailsPath, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('names degraded replays in the summary and counts 0 when every line carried a world', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-eval-out-'))
    // the fixture line has no `world` key → its replay is degraded
    const degraded = await runEval([line()], {
      agent: async () => '```json\n{}\n```',
      oneShot: async () => '```json\n{"verdict": "improved", "reason": "r"}\n```'
    })
    expect(degraded[0].degradedReplay).toBe(true)
    expect(fs.readFileSync(writeReport(out, degraded).reportPath, 'utf8')).toContain(
      'Degraded replays (pre-v2 line, no world — tools answered "unavailable"): 1 — nav-1 #1'
    )

    const withWorld = line()
    withWorld.job.inputSnapshot.world = { sessions: [] }
    const clean = await runEval([withWorld], {
      agent: async () => '```json\n{}\n```',
      oneShot: async () => '```json\n{"verdict": "improved", "reason": "r"}\n```'
    })
    expect(clean[0].degradedReplay).toBe(false)
    expect(fs.readFileSync(writeReport(out, clean).reportPath, 'utf8')).toContain(
      'Degraded replays (pre-v2 line, no world — tools answered "unavailable"): 0\n'
    )
  })
})
