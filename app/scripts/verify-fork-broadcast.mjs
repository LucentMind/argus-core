#!/usr/bin/env node
/**
 * One-off live check for the `skillsFork` broadcast fix.
 *
 * The bug: `skillsFork` did not `broadcast(IPC.skillsChanged, …)`, unlike its sibling
 * `skillsWrite` (and unlike `hivemindClaimReference`, which does broadcast `refsyncChanged`).
 * The editor window decides read-only from the tier map `useAssetTiers` builds off those
 * broadcasts, so after a FORK-IN-PLACE — the fork dialog's default, i.e. the same name — the map
 * still said `hivemind`/`bundled` and the user's own new copy mounted READ-ONLY, permanently:
 * "I could make a copy but then could not edit it."
 *
 *   ARGUS_HOME=/tmp/argus-check node scripts/verify-fork-broadcast.mjs
 */
import { listTargets as list, connect, waitFor, check, report, mainWindow } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9223'
const listTargets = () => list(PORT)
const LOCKED = 'gate-locked' // the seeded hivemind skill

const main = await connect(mainWindow(await listTargets()))

// Straight through the bridge: this is about the main-process broadcast, not about clicking.
const before = await main.evalJs(`(async () => {
  const { skills } = await window.argus.skills.list()
  const s = skills.find((x) => x.name === ${JSON.stringify(LOCKED)})
  return s ? s.tier : null
})()`)
check(`${LOCKED} starts non-user`, before !== null && before !== 'user', before)

// Arm a listener BEFORE forking, so we observe the broadcast itself rather than a later refetch.
await main.evalJs(`(() => {
  window.__forkBroadcast = null
  window.__off = window.argus.skills.onChanged((p) => { window.__forkBroadcast = p })
  return true
})()`)

const created = await main.evalJs(
  `window.argus.skills.fork(${JSON.stringify(LOCKED)}).then((r) => r.name)`
)
check('fork-in-place keeps the name (the dialog default)', created === LOCKED, created)

const broadcast = await waitFor(
  'skills:changed to reach another window after a fork',
  () => main.evalJs(`window.__forkBroadcast ? 1 : false`),
  8000
).catch(() => null)
check('a fork broadcasts skills:changed (the fix)', broadcast === 1)

const tierAfter = await main.evalJs(`(() => {
  const p = window.__forkBroadcast
  if (!p) return 'NO BROADCAST'
  const s = p.skills.find((x) => x.name === ${JSON.stringify(LOCKED)})
  return s ? s.tier : 'MISSING'
})()`)
// This is what the editor's tier map reads, and therefore what releases read-only.
check(
  'the broadcast payload reports the forked skill as user-tier',
  tierAfter === 'user',
  tierAfter
)

await main.evalJs(`(() => { window.__off && window.__off(); return true })()`)
main.close()
report()
