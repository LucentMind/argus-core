import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  listFixtures,
  writeFixtureAssets,
  seedFixtureCase,
  resolveStages,
  readActual,
  checkExpected
} from '../../../../../scripts/lib/fixtures.mjs'
import { openDb } from '../../db'
import { createCase, setCaseStatus } from '../../caseService'
import { retractFinding } from '../../findings'
import { listProposals, rejectProposal, refFileName } from '../../proposals'
import { createFakeRunners } from '../fakeRunner'
import { assembleDistillInput } from '../input'
import { stageDistillOutput } from '../staging'
import { DistillQueue, reconcileAndEnqueue, routeCaseClose } from '../queue'
import { runCaseDistillAgent } from '../caseDistiller'
import { runCaseDistillPipeline } from '../v3/pipeline'
import { runAttributionOnly } from '../v3/attributionOnly'
import { citeKnownIn } from '../v3/dossier'
import { caseDistillPromptHash } from '../promptHash'
import { caseDistillPipelineHash } from '../v3/promptHash'
import { overrideFromProposalReject } from '../overrides'
import type { CaseDistillInput } from '../../../../shared/distill'
import type { DossierCite } from '../../../../shared/distillV3'
import type { CaseResolution } from '../../../../shared/types'

/**
 * Every shipped distillation fixture (scripts/fixtures/distill/*.json) run through the REAL
 * DistillQueue, pipeline, staging, close routing and override write paths, with only the two
 * headless runners swapped for the fake. The queue is wired the way main/index.ts wires it; the
 * fixture's `expected` block is the contract, compared by the loader's own checkExpected.
 */

type OverrideAtRow = { id: number; override_at: string | null }

describe.each(listFixtures().map((fx) => [fx.slug, fx] as const))('fixture %s', (_slug, fx) => {
  let home: string
  let db: DatabaseSync
  let calls: Record<string, number>

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-fx-'))
    db = openDb(path.join(home, 'argus.db'))
    calls = {}
  })
  afterEach(() => {
    // Close before removing: Windows refuses to delete an open database file.
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it(fx.scenario, async () => {
    // The sharpened branches below key on the scenario's leading word (before the first colon).
    // Linkage: a fixture whose shape needs a branch must carry that branch's key, checked before
    // anything runs, so a mistyped scenario fails loudly instead of silently skipping its branch.
    const scenario = fx.scenario.split(':')[0].trim()
    if (fx.actions.some((a) => a.type === 'retract-finding'))
      expect(scenario, 'a retract-finding action needs scenario key "retract"').toBe('retract')
    if (fx.actions.some((a) => a.type === 'reject-proposal'))
      expect(scenario, 'a reject-proposal action needs scenario key "reject"').toBe('reject')
    if (fx.expected.attributions.some((r) => r.verdict === 'misled' && r.override === null))
      expect(scenario, 'an un-overridden misled row needs scenario key "misled"').toBe('misled')
    if (fx.expected.jobs[0].state === 'failed')
      expect(scenario, 'a failed first job needs scenario key "dossier-fail"').toBe('dossier-fail')

    createCase(db, home, {
      slug: fx.slug,
      title: fx.title,
      ...(fx.jiraKey ? { jiraKey: fx.jiraKey } : {})
    })
    writeFixtureAssets(home, fx)
    const caseId = (db.prepare(`SELECT id FROM cases WHERE slug=?`).get(fx.slug) as { id: number })
      .id
    const ids = seedFixtureCase(db, caseId, fx)
    const stages = resolveStages(fx, ids)
    const fake = createFakeRunners(
      { cases: new Map([[fx.slug, stages]]) },
      {
        log: (line) => {
          const s = (JSON.parse(line) as { stage: string }).stage
          calls[s] = (calls[s] ?? 0) + 1
        }
      }
    )
    // The distiller's skill index, built as index.ts builds it: the tier-winning SKILL.md
    // verbatim. Fixture skills are user-tier (written under skills-user/).
    const skillsIndex = fx.assets.skills.map((s) => ({
      name: s.name,
      description: s.description,
      content: fs.readFileSync(path.join(home, 'skills-user', s.name, 'SKILL.md'), 'utf8')
    }))
    const skillTiers = new Map(fx.assets.skills.map((s) => [s.name, 'user' as const]))
    const pipeline = fx.settings.pipeline
    const runners = { agent: fake.agent, oneShot: fake.oneShot }
    const queue = new DistillQueue({
      db,
      argusHome: home,
      assembleInput: (slug, opts) =>
        assembleDistillInput(db, home, slug, skillsIndex, {
          ...(opts?.ignorePriorProposals ? { ignorePriorProposals: true } : {}),
          ...(opts?.attribution !== undefined ? { attribution: opts.attribution } : {}),
          skillTiers
        }),
      distill: (input, signal, onProgress) =>
        pipeline === 'v3'
          ? runCaseDistillPipeline(input, runners, undefined, signal, { onProgress })
          : runCaseDistillAgent(input, runners.agent, undefined, signal, onProgress),
      stage: (slug, jobId, out) => stageDistillOutput(db, home, slug, jobId, out),
      broadcast: () => undefined,
      promptHash: () => (pipeline === 'v3' ? caseDistillPipelineHash() : caseDistillPromptHash()),
      pipelineId: () => pipeline,
      listArchivedProposalsFn: () => [],
      runOneShot: fake.oneShot,
      attributeOnly: (input, signal, onProgress) =>
        runAttributionOnly(input, runners, undefined, signal, { onProgress }),
      judgeModel: () => 'fake'
    })

    if (fx.close) {
      const close = fx.close
      setCaseStatus(
        db,
        home,
        fx.slug,
        'closed',
        close.resolution as CaseResolution,
        (rec, opts) =>
          routeCaseClose(
            { distill: opts.distill, attribution: opts.attribution ?? true },
            {
              enqueueCase: (s, o) => {
                reconcileAndEnqueue(queue, s, o)
              },
              enqueueAttribution: (s) => {
                queue.enqueueAttribution(s)
              }
            },
            rec.slug
          ),
        { distill: close.distill, attribution: close.attribution }
      )
    } else {
      // trigger: 'redistill' — an open-case run from the distill button
      queue.enqueue(fx.slug)
    }
    // The escape-hatch job is enqueued inside runJob before the loop's terminal check, so one
    // idle() covers both the case job and any attribution job it spawns.
    await queue.idle()

    const retracts: { id: number; reason: string }[] = []
    for (const a of fx.actions) {
      if (a.type === 'retract-finding') {
        const id = ids.findingIds[a.finding]
        const r = retractFinding(db, id, a.reason)
        expect(r.ok, `retract finding #${a.finding}`).toBe(true)
        retracts.push({ id, reason: a.reason })
      } else {
        // Same sequence as the proposalsReject IPC handler: read the record BEFORE rejectProposal
        // archives it, then derive the implicit override from it.
        const p = listProposals(home).find(
          (x) => x.caseSlug === fx.slug && x.type === a.proposalType && x.target === a.target
        )
        expect(p, `staged ${a.proposalType} ${a.target}`).toBeTruthy()
        rejectProposal(home, p!.file, { tag: a.reason })
        overrideFromProposalReject(
          db,
          { caseSlug: p!.caseSlug, type: p!.type, target: p!.target },
          { tag: a.reason }
        )
      }
    }

    const actual = readActual(db, fx.slug, calls)
    expect(checkExpected(actual, fx.expected)).toEqual([])

    // ── scenario-specific sharpening (keyed on `scenario`, checked against the shape above) ──
    const overrideAts = (): OverrideAtRow[] =>
      db
        .prepare(`SELECT id, override_at FROM asset_attributions WHERE case_id = ? ORDER BY id`)
        .all(caseId) as unknown as OverrideAtRow[]

    if (scenario === 'retract') {
      // Idempotence: a second identical retraction changes nothing and rewrites no override.
      expect(retracts.length, 'a retract fixture retracts a finding').toBeGreaterThan(0)
      const before = overrideAts()
      expect(
        before.some((r) => r.override_at !== null),
        'the retraction wrote an override'
      ).toBe(true)
      for (const { id, reason } of retracts) {
        const again = retractFinding(db, id, reason)
        expect(again.ok).toBe(true)
        expect(again.ok && again.changed).toBe(false)
      }
      expect(overrideAts()).toEqual(before)
    }

    if (scenario === 'misled') {
      // The misled verdict's cites all resolve against the snapshot the job actually ran on.
      const want = fx.expected.attributions.filter((r) => r.verdict === 'misled')
      expect(want.length, 'a misled fixture expects a misled row').toBeGreaterThan(0)
      for (const w of want) {
        const row = actual.rows.find((r) => r.kind === w.kind && r.name === w.name)
        expect(row, `misled row ${w.kind}/${w.name}`).toBeTruthy()
        const job = db
          .prepare(`SELECT input_snapshot FROM distill_jobs WHERE id = ?`)
          .get(row!.jobId) as { input_snapshot: string }
        const known = citeKnownIn(JSON.parse(job.input_snapshot) as CaseDistillInput)
        const cites = row!.cites as DossierCite[]
        expect(cites.length, `misled row ${w.kind}/${w.name} cites something`).toBeGreaterThan(0)
        for (const c of cites) expect(known(c), `cite ${JSON.stringify(c)} is known`).toBe(true)
      }
    }

    if (scenario === 'reject') {
      // An overgeneric rejection says nothing about whether the asset helped: no override.
      const overgeneric = fx.actions.filter(
        (a) => a.type === 'reject-proposal' && a.reason === 'overgeneric'
      )
      expect(overgeneric.length, 'a reject fixture has an overgeneric rejection').toBeGreaterThan(0)
      for (const a of overgeneric) {
        if (a.type !== 'reject-proposal') continue
        const kind = a.proposalType === 'skill-edit' ? 'skill' : 'reference'
        const name = kind === 'reference' ? refFileName(a.target) : a.target
        const row = actual.rows.find((r) => r.kind === kind && r.name === name)
        expect(row, `row for overgeneric-rejected ${kind}/${name}`).toBeTruthy()
        expect(row!.overrideVerdict).toBeNull()
        expect(row!.overrideSource).toBeNull()
      }
    }

    if (scenario === 'dossier-fail') {
      const dossier = actual.jobs[0]?.stages?.dossier as { error?: string } | undefined
      expect(dossier?.error).toMatch(/expected exactly 1 json fence/)
    }
  })
})
