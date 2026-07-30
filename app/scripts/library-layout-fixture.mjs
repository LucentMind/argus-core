#!/usr/bin/env node
/**
 * Narrow fixture for `library-layout-probe.mjs`, the Library-row CDP layout gate.
 *
 * Seeds the worst-case Library row: a user-tier skill with a long hyphenated name that ALSO
 * exists in the hivemind tier, so the row carries the maximum badge load (`skill` + tier +
 * `overrides hivemind` + the adopt chip + `never activated`) alongside the widest control
 * cluster (Adopt upstream / Edit / Share / toggle).
 *
 * Deliberately kept out of `seed-test-home.mjs` for the same reason as
 * `findings-layout-fixture.mjs`: the probe depends on this exact shape, and folding it into the
 * broad seed would let the gate drift whenever that seed changes for unrelated reasons.
 *
 * Every file written here is read lazily from disk by the app (skill tiers are re-scanned per
 * request; `HivemindService.state()` re-reads its JSON on every call), so this can run either
 * before the first boot or against an already-running instance followed by a reload.
 *
 * Usage:
 *   ARGUS_HOME=/path/to/home node scripts/library-layout-fixture.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.ARGUS_HOME
if (!HOME) throw new Error('ARGUS_HOME is required — refusing to guess a home to write into')
if (path.resolve(HOME) === path.resolve(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Argus'))
  throw new Error('refusing to seed the default home (~/Argus)')

/** The name is the point: long, hyphenated, and it wraps mid-word once the label column is
 *  squeezed. A short name cannot reproduce the defect. */
export const SKILL_NAME = 'triage-a-flaky-test'

const skill = (body) => `---
name: ${SKILL_NAME}
description: Use when a test fails intermittently in CI but passes locally, to separate a real race from an environment artefact before anyone reruns the job.
---

${body}
`

const write = (p, contents) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, contents)
  console.error(`wrote ${p}`)
}

// User tier shadows hivemind → `overrides hivemind` chip + the adopt affordance.
write(
  path.join(HOME, 'skills-user', SKILL_NAME, 'SKILL.md'),
  skill('Your copy. Rerun the job three times before touching the test.')
)
// Different body → `shadowDiverged`, so the adopt chip reads `differs from hivemind`.
write(
  path.join(HOME, 'skills-hivemind', SKILL_NAME, 'SKILL.md'),
  skill("The team's copy. Bisect the seed before rerunning anything.")
)

// Push receipt → the `PR` chip. `pushes` is merged into the payload even when the hivemind
// repo is unconfigured (`payload()` carries it on the dormant branch too), so no repo needed.
const statePath = path.join(HOME, 'config', 'hivemind-state.json')
let state = {}
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
} catch {
  /* first run — the app fills in the rest of the shape lazily */
}
state.pushes = {
  ...(state.pushes ?? {}),
  [`skill/${SKILL_NAME}`]: {
    prUrl: 'https://github.com/JiaweiHan88/HiveMindTest/pull/42',
    pushedAt: '2026-07-29T10:15:00.000Z'
  }
}
write(statePath, JSON.stringify(state, null, 2))
