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
      agent: async () => ({ text: '```json\n{}\n```' }), // candidate agent output (parses)
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
    const regressed = await runEval(cases, {
      agent: async () => ({ text: 'garbage' }),
      oneShot: async () => ''
    })
    expect(regressed[0].parseOutcome).toBe('parse-regressed')
    expect(regressed[0].itemVerdicts).toEqual([]) // nothing to judge against garbage

    const flaky = await runEval(cases, {
      agent: async () => ({ text: '```json\n{}\n```' }),
      oneShot: async () => 'not a verdict'
    })
    expect(flaky[0].itemVerdicts[0].verdict.verdict).toBe('needs-human')
  })

  it('a budget-exhausted replay is never counted ok and is never graded, even when its text parses', async () => {
    const cases = [
      {
        ...line(),
        items: [{ type: 'skill-new', target: 's', title: 't', outcome: 'rejected' as const, rejectReason: 'overfit' }]
      }
    ]
    const judgeRun = vi.fn(async () => '```json\n{"verdict": "improved", "reason": "r"}\n```')
    const results = await runEval(cases, {
      // parseable text, but the SDK cut the run off — the app fails such jobs rather than
      // parsing them, so a verdict here would credit the candidate for a run that never finished
      agent: async () => ({ text: '```json\n{}\n```', capSubtype: 'error_max_turns' }),
      oneShot: judgeRun
    })
    expect(results[0].parseOutcome).toBe('budget-exhausted')
    expect(results[0].capSubtype).toBe('error_max_turns')
    expect(results[0].itemVerdicts).toEqual([])
    expect(judgeRun).not.toHaveBeenCalled()

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-eval-out-'))
    const md = fs.readFileSync(writeReport(out, results).reportPath, 'utf8')
    expect(md).toContain(
      'Capped or errored replays (agent did not finish, NOT graded): 1 — nav-1 #1 (budget-exhausted)'
    )
    expect(md).toContain('Parse: ok 0') // and it did NOT sneak into the ok column
  })

  it('labels a non-budget terminal subtype as an agent error, not budget-exhausted', async () => {
    const cases = [
      { ...line(), items: [{ type: 'skill-new', target: 's', title: 't', outcome: 'accepted' as const }] }
    ]
    const results = await runEval(cases, {
      // `error_during_execution` is a real crash mid-run, not the app's turn-count cap —
      // calling it "budget-exhausted" would misdescribe it as a limit working as intended.
      agent: async () => ({ text: '```json\n{}\n```', capSubtype: 'error_during_execution' }),
      oneShot: async () => '```json\n{"verdict": "improved", "reason": "r"}\n```'
    })
    expect(results[0].capSubtype).toBe('error_during_execution')

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-eval-out-'))
    const md = fs.readFileSync(writeReport(out, results).reportPath, 'utf8')
    expect(md).toContain(
      'Capped or errored replays (agent did not finish, NOT graded): 1 — nav-1 #1 (agent-error (error_during_execution))'
    )
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
      agent: async () => ({ text: 'unused — reused replay skips the candidate run too' }),
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
      { agent: async () => ({ text: '```json\n{}\n```' }), oneShot: async () => 'malformed judge' }
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
      agent: async () => ({ text: '```json\n{}\n```' }),
      oneShot: async () => '```json\n{"verdict": "improved", "reason": "r"}\n```'
    })
    expect(degraded[0].degradedReplay).toBe(true)
    expect(fs.readFileSync(writeReport(out, degraded).reportPath, 'utf8')).toContain(
      'Degraded replays (pre-v2 line, no world — tools answered "unavailable"): 1 — nav-1 #1'
    )

    const withWorld = line()
    withWorld.job.inputSnapshot.world = { sessions: [] }
    const clean = await runEval([withWorld], {
      agent: async () => ({ text: '```json\n{}\n```' }),
      oneShot: async () => '```json\n{"verdict": "improved", "reason": "r"}\n```'
    })
    expect(clean[0].degradedReplay).toBe(false)
    expect(fs.readFileSync(writeReport(out, clean).reportPath, 'utf8')).toContain(
      'Degraded replays (pre-v2 line, no world — tools answered "unavailable"): 0\n'
    )
  })
})
