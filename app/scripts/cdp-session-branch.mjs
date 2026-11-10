#!/usr/bin/env node
/**
 * Session rewind + fork live gate (spec §9.5) — drives the REAL app over CDP against a scratch
 * ARGUS_HOME, with a REAL Claude Agent SDK session. Costs a few cents.
 *
 * What only a live run can prove, and why every one of these is here:
 *  - The SDK's file checkpointing actually restores `note.txt` from "v2" to "v1". No unit test
 *    can: `rewindFiles` is a control method on a live CLI child, and the fake driver every
 *    `sessionBranch` test uses returns a canned cursor without touching the disk.
 *  - The forked cursor still carries turn 1's context — the probe's answer names `note.txt`
 *    and `v1`, which the model can only know from the transcript slice the fork kept.
 *  - The provider anchor ids captured per turn are ones `forkSession` accepts. A wrong anchor
 *    does not throw in any fake; live, it either forks at the wrong point (only the probe's
 *    answer can tell) or is rejected outright — which is exactly how this gate found the
 *    stale-anchor defect fixed in `sessionBranch.ts` on 2026-09-05.
 *  - The renderer's greyed tail, the fork divider and the composer prefill render off real
 *    `SessionSummary.rewound` / `forkedFrom` payloads rather than the hand-built fixtures the
 *    jsdom suite feeds them (memory `argus-jsdom-runtime-blind-spots`).
 *  - The archive round-trip puts the rewound tail and the fork lineage back with REMAPPED ids.
 *
 * ── Stored vs derived anchors ────────────────────────────────────────────────────────────────
 *
 * The fork is taken BEFORE the parent's rewind, so §2 slices at an anchor the STREAM recorded.
 * Everything after it branches at a turn whose stored anchor is NULL — a fork's inherited turn
 * (V2), or a turn that survived a native rewind (V14), whose uuids the SDK remapped — and so
 * exercises the anchor `sessionBranch.branchAnchor` DERIVES from the current cursor's
 * transcript (2026-10-23). Until then each of those was a digest branch: §3b forks a fork, §4
 * rewinds a fork at an inherited turn, §6b rewinds the parent a SECOND time, and §7 forks again
 * at a turn that predates both rewinds (the exact call that used to die on a stale anchor). All
 * four must now be native, and §4, §6b and §7 each re-ask the probe to show the context held.
 *
 * ── The run ──────────────────────────────────────────────────────────────────────────────────
 *
 *   1. ARGUS_HOME=<fresh scratch home> node scripts/cdp-session-branch.mjs seed
 *   2. ARGUS_HOME=<same home> npx electron-vite dev --remoteDebuggingPort 9251
 *   3. ARGUS_HOME=<same home> CDP_PORT=9251 node scripts/cdp-session-branch.mjs
 *
 * `seed` writes `<home>/config/settings.json` BEFORE the app boots. It has to be a separate
 * phase rather than a merge-and-wait like `cdp-distill-v3.mjs`'s pipeline flag, for two
 * reasons: `onboarding.completedAt` is read when the wizard mounts, so a home that boots
 * without it puts the first-run wizard over the case list this gate has to click through; and
 * `agent.defaultPermissionMode` is only meaningful if it survives `migrateBypassDefault`, which
 * resets a stored `bypassPermissions` unless `migrations.bypassDefaultReset` is already stamped
 * (settingsMigrations.ts) — so the stamp has to be on disk before the first boot, not written
 * over the top of a migration that has already run.
 *
 * Bypass approvals is deliberate and load-bearing: the turns below write files, and in any
 * other mode the run parks forever on an approval card no script clicks. It is an ATTENDED
 * session (a plain IPC send, not a routine), so `CaseSession`'s unattended downgrade
 * (session.ts) does not apply and the mode reaches the SDK intact.
 *
 * Use a FRESH home per run. The gate rewinds and forks the one session it seeds, so a re-run
 * against a home that already has them starts from a state none of the assertions describe.
 *
 * Exits 0 when every check passes, 1 on a failed check, 2 when the run must not happen at all
 * (wrong app on the port, wrong permission mode — see `argus-cdp-port-collision`).
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { listTargets, connect, mainWindow, sleep, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9251'
const HOME = process.env.ARGUS_HOME
if (!HOME) {
  console.error('ARGUS_HOME is required (the scratch home the app was booted against)')
  process.exit(2)
}
const SLUG = 'live-branch-note-rewind'
const TITLE = 'Rewind and fork the note.txt chat'
const DB = path.join(HOME, 'argus.db')
const NOTE = path.join(HOME, 'cases', SLUG, 'note.txt')

/** The three seeding prompts. Turn 2 overwrites turn 1's file; turn 3 touches nothing, so the
 *  rewound tail is two turns of which only one wrote a file. The Write tool is named because
 *  the SDK's file checkpoints track only its own edit tools, never Bash: on 2026-10-23 the model
 *  chose `echo > note.txt`, nothing was checkpointed, and the §5 restore had nothing to restore. */
const P1 =
  'Use the Write tool (not Bash) to create a file named note.txt in the current directory whose entire contents are the single line v1. Then reply with exactly: done'
const P2 =
  'Use the Write tool (not Bash) to overwrite note.txt in the current directory so its entire contents are the single line v2. Then reply with exactly: done'
const P3 = 'Reply with exactly: ok. Do not use any tools.'
/** Asked wherever turn 1's context is supposed to have survived. Answerable only from it. */
const PROBE = 'What did I ask you in my first message? One line.'

// ---------- seed phase ----------
function seed() {
  const file = path.join(HOME, 'config', 'settings.json')
  let cur = {}
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* absent or unparseable — a partial file is what the app then reads, and the schema fills
       every absent key, so a small file is enough on a fresh home. */
  }
  const now = new Date().toISOString()
  const next = {
    ...cur,
    agent: { ...(cur.agent ?? {}), defaultPermissionMode: 'bypassPermissions' },
    // Without this stamp `migrateBypassDefault` resets the mode above on the very first boot
    // and every write turn below parks on an approval card.
    migrations: { ...(cur.migrations ?? {}), bypassDefaultReset: now },
    onboarding: { ...(cur.onboarding ?? {}), completedAt: now, phase1Done: true, tourDone: true }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  console.error(
    `seeded ${file}\nnow boot:\n  ARGUS_HOME=${HOME} npx electron-vite dev --remoteDebuggingPort ${PORT}`
  )
}

if (process.argv[2] === 'seed') {
  seed()
  process.exit(0)
}

// ---------- DB helpers ----------
/** Open, read, close. The app holds the same file open; a handle kept across a multi-minute
 *  agent turn is a Windows lock waiting to happen (memory `argus-live-gate-lessons`). */
function q(sql, ...params) {
  const db = new DatabaseSync(DB)
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}
const turnsOf = (sessionId) =>
  q(
    `SELECT id, turn_index, status, rewound_at, rewound_to_turn_id, provider_anchor_id
       FROM turns WHERE session_id = ? ORDER BY id`,
    sessionId
  )
const sessionRow = (id) =>
  q(
    `SELECT id, title, driver_cursor, pre_rewind_cursor, forked_from_session_id,
            forked_at_turn_id, forked_inherited_turns, forked_branching
       FROM sessions WHERE id = ?`,
    id
  )[0] ?? null
/** A turn's assistant text, straight out of the message index the app itself writes. */
const assistantText = (sessionId, turnId) =>
  q(
    `SELECT content FROM messages_fts WHERE session_id = ? AND turn_id = ? AND role = 'assistant'`,
    sessionId,
    turnId
  )
    .map((r) => String(r.content))
    .join('\n')

const noteText = () => (fs.existsSync(NOTE) ? fs.readFileSync(NOTE, 'utf8').trim() : null)

/** Turn 1's subject in the model's own words: the reply has to name the file and the content. */
const knowsTurn1 = (text) => {
  const t = String(text ?? '').toLowerCase()
  return t.includes('note.txt') && t.includes('v1')
}

const TURN_BUDGET_MS = 6 * 60 * 1000

const main = async () => {
  const targets = await listTargets(PORT)
  const conn = await connect(mainWindow(targets))
  console.error(`connected to ${PORT}: ${targets.map((t) => t.url).join(', ')}`)

  const body = () => conn.evalJs(`document.body.innerText`)
  const dialogText = () =>
    conn.evalJs(
      `(() => { const d = document.querySelector('[role="dialog"]'); return d ? d.innerText : '' })()`
    )
  const dialogLabel = () =>
    conn.evalJs(
      `(() => { const d = document.querySelector('[role="dialog"]'); return d ? d.getAttribute('aria-label') : null })()`
    )
  const clickText = (text) =>
    conn.evalJs(`(() => {
      const el = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)})
      if (!el) return false
      el.click()
      return true
    })()`)
  const clickAria = (label) =>
    conn.evalJs(`(() => {
      const el = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']')
      if (!el) return false
      el.click()
      return true
    })()`)

  /** Send a prompt through the app's own IPC and wait for its turn row to reach a terminal
   *  state. Polled off the database rather than the DOM: the row is what every assertion below
   *  reads, and a streamed reply is on screen before the row is final. */
  async function sendTurn(sessionId, text, label) {
    const before = new Set(turnsOf(sessionId).map((t) => t.id))
    await conn.evalJs(
      `window.argus.agent.send(${JSON.stringify(SLUG)}, ${sessionId}, ${JSON.stringify(text)})`
    )
    const t0 = Date.now()
    const row = await waitFor(
      `${label} to complete`,
      () => turnsOf(sessionId).find((t) => !before.has(t.id) && t.status !== 'running') ?? null,
      TURN_BUDGET_MS
    )
    console.error(
      `${label}: turn ${row.id} ${row.status} in ${Math.round((Date.now() - t0) / 1000)}s`
    )
    return row
  }

  /** Open the case from the home view and wait for its composer. */
  async function openCase() {
    await conn.send('Page.reload', { ignoreCache: true })
    await sleep(3500)
    await waitFor('case list to load', () =>
      conn.evalJs(`document.querySelectorAll('[data-testid="case-title"]').length > 0`)
    )
    const clicked = await conn.evalJs(`(() => {
      const h = [...document.querySelectorAll('[data-testid="case-title"]')]
        .find((el) => el.textContent.trim() === ${JSON.stringify(TITLE)})
      if (!h) return false
      h.click()
      return true
    })()`)
    if (!clicked) throw new Error(`case card ${JSON.stringify(TITLE)} not on screen`)
    await waitFor(
      'composer to mount',
      () => conn.evalJs(`!!document.querySelector('textarea[placeholder^="Message the analyst"]')`),
      30000
    )
  }

  /** The chat-switcher rows' accessible names, with the popup left open. */
  async function openSwitcher() {
    await clickAria('Switch chat')
    await sleep(600)
    return conn.evalJs(`(() => [...document.querySelectorAll('[aria-label^="Switch to "]')]
      .map((b) => b.getAttribute('aria-label')))()`)
  }
  /** Switch to the one chat whose row label does (or does not) end in "(fork)". */
  async function switchTo(wantFork) {
    const labels = await openSwitcher()
    const label = labels.find((l) => l.endsWith('(fork)') === wantFork)
    if (!label)
      throw new Error(`no ${wantFork ? 'fork' : 'parent'} row in ${JSON.stringify(labels)}`)
    if (!(await clickAria(label))) throw new Error(`could not click ${label}`)
    await sleep(1500)
    return label
  }

  /** The transcript's per-turn "⋯" triggers, in document order. Index 0 is the oldest LIVE
   *  turn: `TurnActions` never mounts inside a `RewoundTail` (ChatPane's `renderItem` is told
   *  `{ rewound: true }` there), so rewound turns do not shift this list. */
  const turnActionCount = () =>
    conn.evalJs(`document.querySelectorAll('[aria-label="turn actions"]').length`)
  /** Open turn `index`'s menu and pick `item`. Retries the open once: the menu closes on any
   *  scroll of its container, and the transcript auto-scrolls when a turn lands. */
  async function pickTurnAction(index, item) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const opened = await conn.evalJs(`(() => {
        const els = [...document.querySelectorAll('[aria-label="turn actions"]')]
        if (!els[${index}]) return false
        els[${index}].click()
        return true
      })()`)
      if (!opened) throw new Error(`no turn-actions menu at index ${index}`)
      await sleep(500)
      if (await clickText(item)) return
    }
    throw new Error(`${JSON.stringify(item)} never appeared in turn ${index}'s menu`)
  }

  // ── 0. identity + permission gates ──────────────────────────────────────────────────────
  const existing = await conn.evalJs(`window.argus.cases.list()`)
  if (!(existing ?? []).some((c) => c.slug === SLUG)) {
    await conn.evalJs(`window.argus.cases.create(${JSON.stringify({ slug: SLUG, title: TITLE })})`)
  }
  const cases = await conn.evalJs(`window.argus.cases.list()`)
  const mine = (cases ?? []).find((c) => c.slug === SLUG)
  if (!mine) {
    console.error(
      `IDENTITY FAIL: port ${PORT} does not show fixture case ${SLUG}; refusing to continue`
    )
    process.exit(2)
  }
  check('identity: fixture case visible on the connected app', true, mine.title)

  // Before the money is spent, and before a write turn can park on an approval card nothing
  // will click: the mode this gate needs must be the mode the app actually reports.
  const settings = await conn.evalJs(`window.argus.settings.get()`)
  const mode = settings?.settings?.agent?.defaultPermissionMode
  if (mode !== 'bypassPermissions') {
    console.error(
      `PERMISSION FAIL: the app reports agent.defaultPermissionMode=${JSON.stringify(mode)}, not ` +
        '"bypassPermissions". Run the `seed` phase against this home and reboot the app; a write ' +
        'turn in any other mode waits forever on an approval card.'
    )
    process.exit(2)
  }
  check('app reports agent.defaultPermissionMode=bypassPermissions', true, mode)

  // ── 1. seed the three turns ─────────────────────────────────────────────────────────────
  let sessions = await conn.evalJs(`window.argus.sessions.list(${JSON.stringify(SLUG)})`)
  if (!sessions.length) {
    await conn.evalJs(`window.argus.sessions.create(${JSON.stringify(SLUG)})`)
    sessions = await conn.evalJs(`window.argus.sessions.list(${JSON.stringify(SLUG)})`)
  }
  const SID = sessions[0].id
  // GATE_MODEL pins the chat to a model the SDK's BUNDLED CLI can run. A fresh home seeds the
  // newest default, which can be ahead of that CLI — then every turn is an API 400, and the run
  // below would be assertions about error stubs (found 2026-10-23: 2.1.263 vs claude-opus-5-5).
  if (process.env.GATE_MODEL) {
    await conn.evalJs(
      `window.argus.sessions.setModel(${SID}, ${JSON.stringify(sessions[0].instanceId)}, ${JSON.stringify(process.env.GATE_MODEL)})`
    )
  }

  // Open the case BEFORE sending, so the transcript builds off the live event stream rather
  // than a replay — which is what the renderer assertions below are actually about.
  await openCase()

  let rows = turnsOf(SID)
  if (rows.length === 0) {
    const first = await sendTurn(SID, P1, 'turn 1 (write v1)')
    if (first.status !== 'success') {
      console.error(
        `SETUP FAIL: turn 1 ended '${first.status}': ${assistantText(SID, first.id).slice(0, 300)}\n` +
          'Every check below would describe an error stub. Fix the model/CLI (GATE_MODEL=…) and ' +
          'rerun against a FRESH home.'
      )
      process.exit(2)
    }
    await sendTurn(SID, P2, 'turn 2 (overwrite v2)')
    await sendTurn(SID, P3, 'turn 3 (no tools)')
    rows = turnsOf(SID)
  }
  check(
    'three turns completed successfully',
    rows.length === 3 && rows.every((t) => t.status === 'success'),
    rows.map((t) => `${t.id}:${t.status}`)
  )
  check('note.txt on disk reads "v2" before the rewind', noteText() === 'v2', noteText())
  // The anchor capture (Task 3) — an id per turn, and DIFFERENT ids, which is what proves the
  // per-turn reset rather than one uuid stamped on everything.
  const anchors = rows.map((t) => t.provider_anchor_id)
  check(
    'every seeded turn carries its own provider_anchor_id',
    anchors.every((a) => typeof a === 'string' && a.length > 0) &&
      new Set(anchors).size === anchors.length,
    anchors
  )
  const [T1] = rows
  const menus = await turnActionCount()
  check('a turn-actions menu is mounted on each of the three live turns', menus === 3, menus)

  // ── 2. fork from turn 1, natively ───────────────────────────────────────────────────────
  const beforeFork = new Set(sessions.map((s) => s.id))
  await pickTurnAction(0, 'Fork from here')
  await waitFor('the fork confirm dialog', async () => (await dialogLabel()) === 'Fork from here?')
  const forkAsk = await dialogText()
  check(
    'the fork confirm promises full context (the native branch of the sentence)',
    forkAsk.includes('keeps its full context up to this point'),
    forkAsk.split('\n')[1]
  )
  if (!(await clickText('Fork'))) throw new Error('Fork button not in the dialog')
  const forkSummary = await waitFor(
    'the forked session to appear',
    async () => {
      const list = await conn.evalJs(`window.argus.sessions.list(${JSON.stringify(SLUG)})`)
      return list.find((s) => !beforeFork.has(s.id)) ?? null
    },
    120000
  )
  const FID = forkSummary.id
  check(
    'the sessions list gains a "(fork)" chat',
    typeof forkSummary.title === 'string' && forkSummary.title.endsWith('(fork)'),
    forkSummary.title
  )
  const forkRow = sessionRow(FID)
  check(
    'the fork records its lineage (parent, anchor turn, inherited count)',
    forkRow?.forked_from_session_id === SID &&
      forkRow?.forked_at_turn_id === T1.id &&
      forkRow?.forked_inherited_turns === 1,
    forkRow
  )
  check(
    'the fork got its own provider cursor from forkSession',
    typeof forkRow?.driver_cursor === 'string' &&
      forkRow.driver_cursor !== sessionRow(SID)?.driver_cursor,
    { fork: forkRow?.driver_cursor, parent: sessionRow(SID)?.driver_cursor }
  )
  const inheritedTurn = turnsOf(FID)[0]
  check(
    'the inherited turn row carries a NULL provider_anchor_id (deviation V2)',
    turnsOf(FID).length === 1 && inheritedTurn.provider_anchor_id === null,
    turnsOf(FID)
  )

  // ChatPane switches to the fork itself (onSwitchSession) — wait for the divider rather than
  // clicking the switcher, then read the switcher's own list for the DOM half of the claim.
  const forkText = await waitFor(
    'the fork transcript to render its divider',
    async () => {
      const t = await body()
      return t.includes('Forked from chat') ? t : null
    },
    30000
  )
  check(
    'the fork transcript shows the native fork divider',
    forkText.includes(`Forked from chat ${SID}`) && forkText.includes('full context carried over'),
    forkText.split('\n').find((l) => l.includes('Forked from chat'))
  )
  const switcherLabels = await openSwitcher()
  check(
    'the chat switcher lists the forked chat',
    switcherLabels.some((l) => l.endsWith('(fork)')),
    switcherLabels
  )
  await clickAria('Switch chat') // toggle the popup shut again
  await sleep(400)

  // ── 3. the fork remembers the inherited turn ────────────────────────────────────────────
  const forkProbe = await sendTurn(FID, PROBE, 'probe (fork)')
  const forkProbeText = assistantText(FID, forkProbe.id)
  console.error(`fork probe reply: ${forkProbeText}`)
  check(
    'the fork answers the probe from the inherited turn 1',
    knowsTurn1(forkProbeText),
    forkProbeText.slice(0, 200)
  )

  // ── 3b. fork AT an inherited turn (no stored anchor) — native via the derived anchor ─────
  //
  // The fork's inherited turn carries `provider_anchor_id = NULL` (V2), so the anchor is
  // derived from the fork's own transcript. I3 (whole-branch review) still applies: the
  // confirm sentence and the permanent divider must state what main actually did, and both are
  // checked against the row, not against the driver's capability.
  //
  // Free: `forkSession` is a transcript copy, no model call. The grandchild is deleted again
  // below, because §8 asserts the case restores to exactly the two chats it archived.
  const beforeG = new Set(
    (await conn.evalJs(`window.argus.sessions.list(${JSON.stringify(SLUG)})`)).map((s) => s.id)
  )
  await pickTurnAction(0, 'Fork from here')
  await waitFor(
    'the grandchild fork confirm dialog',
    async () => (await dialogLabel()) === 'Fork from here?',
    30000
  )
  const gAsk = await dialogText()
  if (!(await clickText('Fork'))) throw new Error('Fork button not in the grandchild fork dialog')
  const gSummary = await waitFor(
    'the grandchild fork to appear',
    async () => {
      const list = await conn.evalJs(`window.argus.sessions.list(${JSON.stringify(SLUG)})`)
      return list.find((s) => !beforeG.has(s.id)) ?? null
    },
    60000
  )
  const gText = await waitFor(
    'the grandchild transcript to render its divider',
    async () => {
      const t = await body()
      return t.includes(`Forked from chat ${FID}`) ? t : null
    },
    30000
  )
  check(
    'forking a fork at an inherited turn promises, shows and records the NATIVE branch',
    gAsk.includes('keeps its full context up to this point') &&
      gText.includes('full context carried over') &&
      !gText.includes('a summary of the history carried over') &&
      gSummary.forkedFrom?.branching === 'native' &&
      sessionRow(gSummary.id)?.forked_branching === 'native' &&
      typeof sessionRow(gSummary.id)?.driver_cursor === 'string' &&
      sessionRow(gSummary.id)?.driver_cursor !== sessionRow(FID)?.driver_cursor,
    {
      confirm: gAsk.split('\n')[1],
      divider: gText.split('\n').find((l) => l.includes('Forked from chat')),
      summary: gSummary.forkedFrom,
      row: sessionRow(gSummary.id)
    }
  )
  // Back to the parent (the only row NOT ending in "(fork)" — unambiguous while two forks
  // exist), drop the grandchild, then return to the fork for §4.
  await switchTo(false)
  await conn.evalJs(`window.argus.sessions.delete(${JSON.stringify(SLUG)}, ${gSummary.id})`)
  await sleep(800)
  await switchTo(true)
  await waitFor('the fork transcript again', async () => (await turnActionCount()) === 2, 30000)

  // ── 4. rewind the FORK at an inherited turn — native via the derived anchor ──────────────
  //
  // Formerly the digest path (spec §9.5 bullet 3): an inherited turn has no stored anchor (V2).
  // Only a live run shows the derived one is real: in every unit test the transcript is a
  // fixture. Whether files can be restored on a fork depends on the SDK's checkpoints for it,
  // so the dialog may say either native wording — but never the digest's.
  const forkCursorBefore = sessionRow(FID)?.driver_cursor
  await pickTurnAction(0, 'Rewind to here')
  await waitFor('the fork rewind confirm dialog', async () => (await dialogLabel()) !== null, 90000)
  const forkRewindAsk = await dialogText()
  console.error(`--- fork rewind confirm ---\n${forkRewindAsk}\n---------------------------`)
  check(
    'rewinding at an inherited turn is offered natively, not as the digest path',
    !forkRewindAsk.includes('files are not restored on this provider') &&
      (forkRewindAsk.includes('Files restored') ||
        forkRewindAsk.includes('Files cannot be restored')),
    forkRewindAsk.split('\n').slice(0, 6)
  )
  if (!(await clickText('Rewind'))) throw new Error('Rewind button not in the fork dialog')
  await waitFor(
    'the fork rewind to land',
    () => turnsOf(FID).filter((t) => t.status === 'rewound').length === 1,
    120000
  )
  const forkAfter = sessionRow(FID)
  check(
    'the native rewind swaps in a new provider cursor and remembers the old one',
    typeof forkAfter.driver_cursor === 'string' &&
      forkAfter.driver_cursor !== forkCursorBefore &&
      forkAfter.pre_rewind_cursor === forkCursorBefore,
    forkAfter
  )
  const forkListed = (
    await conn.evalJs(`window.argus.sessions.list(${JSON.stringify(SLUG)})`)
  ).find((s) => s.id === FID)
  check(
    'the rewound fork shows no "summary" banner (historyOrphaned false)',
    forkListed?.historyOrphaned === false,
    forkListed?.historyOrphaned
  )
  const forkReplay = await sendTurn(FID, PROBE, 'probe (fork, after native rewind)')
  const forkReplayText = assistantText(FID, forkReplay.id)
  console.error(`fork replay reply: ${forkReplayText}`)
  check(
    'after the rewind the fork still answers from the inherited turn (resumed, not replayed)',
    knowsTurn1(forkReplayText),
    forkReplayText.slice(0, 200)
  )

  // ── 5. back to the parent, and rewind it natively ───────────────────────────────────────
  await switchTo(false)
  await waitFor('the parent transcript', async () => (await turnActionCount()) === 3, 30000)
  await pickTurnAction(0, 'Rewind to here')
  // `rewindPreview` runs a real dry-run `rewindFiles` against a live CLI child — seconds, not
  // milliseconds, so this waits for the dialog rather than sleeping at it.
  const label = await waitFor('the rewind confirm dialog', () => dialogLabel(), 90000)
  check('confirm dialog is titled "Rewind 2 turns?"', label === 'Rewind 2 turns?', label)
  const confirmBody = await dialogText()
  console.error(`--- confirm body ---\n${confirmBody}\n--------------------`)
  check(
    'confirm body says 2 turns will be discarded',
    /2 turns will be discarded/.test(confirmBody),
    confirmBody.split('\n')[1]
  )
  check(
    'confirm body lists note.txt under "Files restored"',
    /Files\s+restored/.test(confirmBody) &&
      confirmBody.slice(confirmBody.indexOf('Files')).includes('note.txt'),
    confirmBody.slice(confirmBody.indexOf('Files'), confirmBody.indexOf('Files') + 200)
  )
  if (!(await clickText('Rewind'))) throw new Error('Rewind button not in the dialog')
  await waitFor(
    'the rewind to land in the database',
    () => turnsOf(SID).filter((t) => t.status === 'rewound').length === 2,
    120000
  )

  check('note.txt on disk is restored to "v1"', noteText() === 'v1', noteText())
  const after = turnsOf(SID)
  const tail = after.filter((t) => t.status === 'rewound')
  check(
    'the two tail turns are rewound, pointing at turn 1',
    tail.length === 2 && tail.every((t) => t.rewound_to_turn_id === T1.id && t.rewound_at),
    tail
  )
  const anchorAfter = after.find((t) => t.id === T1.id)
  check(
    'the anchor turn itself stays live',
    anchorAfter?.status === 'success' && anchorAfter?.rewound_at == null,
    anchorAfter
  )
  // The stale-anchor fix (found live 2026-09-05): the new cursor is a fork of the old provider
  // session, and its message uuids are remapped, so the surviving turn's recorded anchor names
  // nothing there and must be forgotten rather than handed back to the SDK.
  check(
    'the surviving turn forgets its (now stale) provider anchor',
    anchorAfter?.provider_anchor_id === null,
    anchorAfter?.provider_anchor_id
  )
  const composer = await waitFor(
    'the composer to hold the first discarded prompt',
    () =>
      conn.evalJs(
        `(() => { const t = document.querySelector('textarea[placeholder^="Message the analyst"]'); return t && t.value ? t.value : null })()`
      ),
    20000
  ).catch(() => null)
  check("the composer holds turn 2's prompt", composer === P2, composer)
  const afterText = await body()
  check(
    'the transcript shows a "Rewound 2 turns" divider',
    afterText.includes('Rewound 2 turns'),
    afterText.split('\n').find((l) => l.includes('Rewound'))
  )

  // ── 6. the probe: does the rewound session still know turn 1? ───────────────────────────
  const probe = await sendTurn(SID, PROBE, 'probe (rewound session)')
  const probeText = assistantText(SID, probe.id)
  console.error(`probe reply: ${probeText}`)
  check(
    'the rewound session answers the probe from turn 1 (names note.txt and v1)',
    knowsTurn1(probeText),
    probeText.slice(0, 200)
  )
  check(
    'the post-rewind turn records a provider_anchor_id on the FORKED cursor',
    typeof probe.provider_anchor_id === 'string' && probe.provider_anchor_id.length > 0,
    probe.provider_anchor_id
  )

  // ── 6b. rewind the parent a SECOND time, at the same turn ───────────────────────────────
  //
  // T1 survived the first rewind, so its stored anchor was forgotten (V14) and the probe turn
  // above lives on the forked cursor. Rewinding to T1 again discards that probe — natively,
  // with T1's anchor found in the CURRENT cursor's transcript.
  const parentCursorBefore = sessionRow(SID)?.driver_cursor
  await waitFor('the parent transcript', async () => (await turnActionCount()) === 2, 30000)
  await pickTurnAction(0, 'Rewind to here')
  const label2 = await waitFor('the second rewind confirm dialog', () => dialogLabel(), 90000)
  const confirm2 = await dialogText()
  console.error(`--- second rewind confirm ---\n${confirm2}\n-----------------------------`)
  check(
    'the second rewind is offered natively ("Rewind 1 turn?", not the digest wording)',
    label2 === 'Rewind 1 turn?' && !confirm2.includes('files are not restored on this provider'),
    { label: label2, body: confirm2.split('\n').slice(0, 6) }
  )
  if (!(await clickText('Rewind'))) throw new Error('Rewind button not in the second dialog')
  await waitFor(
    'the second rewind to land',
    () => turnsOf(SID).filter((t) => t.status === 'rewound').length === 3,
    120000
  )
  const parentAfter2 = sessionRow(SID)
  check(
    'the second rewind swaps in yet another provider cursor',
    typeof parentAfter2.driver_cursor === 'string' &&
      parentAfter2.driver_cursor !== parentCursorBefore &&
      parentAfter2.pre_rewind_cursor === parentCursorBefore,
    parentAfter2
  )
  const probe2 = await sendTurn(SID, PROBE, 'probe (after second rewind)')
  const probe2Text = assistantText(SID, probe2.id)
  console.error(`second probe reply: ${probe2Text}`)
  check(
    'after the second rewind the session still answers from turn 1',
    knowsTurn1(probe2Text),
    probe2Text.slice(0, 200)
  )

  // ── 7. the regression this gate found: branching again after a rewind ────────────────────
  //
  // Before the stale-anchor fix this exact call threw `Message <anchor> not found in session
  // <new cursor>`; after it, it degraded to digest. Now it must be a native fork that still
  // knows turn 1. Then drop the throwaway chat so the archive assertions below stay about the
  // two chats the rest of this gate is describing.
  let extra = null
  try {
    extra = await conn.evalJs(
      `window.argus.sessions.fork(${JSON.stringify(SLUG)}, ${SID}, ${T1.id})`
    )
  } catch (err) {
    extra = { error: String(err && err.message ? err.message : err) }
  }
  check(
    'forking again at a turn that predates both rewinds is NATIVE',
    typeof extra?.id === 'number' &&
      typeof sessionRow(extra.id)?.driver_cursor === 'string' &&
      sessionRow(extra.id)?.forked_branching === 'native',
    extra?.id ? sessionRow(extra.id) : extra
  )
  if (typeof extra?.id === 'number') {
    const extraProbe = await sendTurn(extra.id, PROBE, 'probe (fork after rewinds)')
    const extraText = assistantText(extra.id, extraProbe.id)
    console.error(`fork-after-rewinds probe reply: ${extraText}`)
    check(
      'the fork taken after both rewinds answers from turn 1',
      knowsTurn1(extraText),
      extraText.slice(0, 200)
    )
    await conn.evalJs(`window.argus.sessions.delete(${JSON.stringify(SLUG)}, ${extra.id})`)
  }

  // ── 8. archive round-trip ───────────────────────────────────────────────────────────────
  //
  // ARCHIVE, not bundle export/import. `bundle:export` passes no `includeRows`, and
  // `importCase` deliberately does not consume `rows.json` at all (bundle.ts: an import would
  // otherwise replay another machine's audit trail) — so turn rows, and with them the whole
  // rewound tail and the fork lineage, cannot survive a plain export/import by design.
  // `archiveCase`/`restoreCase` are the only pair that round-trips them, and they are what
  // spec §9.5's "export … import" maps onto (Task 12).
  const archived = await conn.evalJs(`window.argus.cases.archive(${JSON.stringify(SLUG)})`)
  console.error(`archived: ${JSON.stringify(archived)}`)
  check(
    "archive removes the case's turn rows (so the restore below proves something)",
    q(`SELECT id FROM turns WHERE session_id IN (?, ?)`, SID, FID).length === 0,
    q(`SELECT id FROM turns WHERE session_id IN (?, ?)`, SID, FID).length
  )
  const restored = await conn.evalJs(`window.argus.cases.restore(${JSON.stringify(SLUG)})`)
  console.error(`restored: ${JSON.stringify(restored)}`)

  // Ids are reassigned by the restore, so every assertion below is on the REMAPPED graph.
  const rSessions = await conn.evalJs(`window.argus.sessions.list(${JSON.stringify(SLUG)})`)
  const rFork = rSessions.find((s) => String(s.title).endsWith('(fork)'))
  const rMain = rSessions.find((s) => s.id !== rFork?.id)
  check(
    'restore brings back both chats',
    rSessions.length === 2 && !!rFork && !!rMain,
    rSessions.map((s) => `${s.id}:${s.title}`)
  )
  // Everything below identifies the two chats by that split. Stop here rather than throwing a
  // TypeError three checks later, which would bury the one failure that actually explains it.
  if (!rFork || !rMain) {
    conn.close()
    report()
  }
  const rTurns = turnsOf(rMain.id)
  const rRewound = rTurns.filter((t) => t.status === 'rewound')
  // The anchor is found through the pointers, NOT by turn_index: `turn_index` is a per-warm-
  // session counter that restarts at 1 every warm-up (deviation V1), so it does not identify a
  // turn even within one session. A pointer that survived remapping is the whole claim anyway.
  const rAnchor = rTurns.find((t) => t.id === (rRewound[0]?.rewound_to_turn_id ?? -1)) ?? null
  // Three: the two from §5 plus the probe the §6b rewind discarded — all pointing at T1.
  check(
    'the rewound tail survives the round-trip with rewound_to_turn_id remapped',
    rRewound.length === 3 &&
      rAnchor != null &&
      rAnchor.status === 'success' &&
      rRewound.every((t) => t.rewound_to_turn_id === rAnchor.id && t.rewound_at),
    { rewound: rRewound.map((t) => `${t.id}->${t.rewound_to_turn_id}`), anchor: rAnchor }
  )
  const rForkRow = sessionRow(rFork.id)
  check(
    'the fork lineage survives with forked_from_session_id remapped to the restored parent',
    rForkRow?.forked_from_session_id === rMain.id &&
      rForkRow?.forked_at_turn_id === rAnchor?.id &&
      rForkRow?.forked_inherited_turns === 1,
    { row: rForkRow, restoredParent: rMain.id, restoredAnchor: rAnchor?.id }
  )
  // The provider-anchor pattern has to survive too, and it is per-ROW: the parent's surviving
  // turn was NULLed by its own rewind, its rewound tail kept the ids it recorded before it, and
  // the fork's first turn is the inherited copy. A blanket "all null" or "all set" would pass
  // while any one of those three facts had been lost.
  const rForkTurns = turnsOf(rFork.id)
  check(
    'restored provider anchors keep their per-row pattern',
    rAnchor?.provider_anchor_id === null &&
      rRewound.every((t) => typeof t.provider_anchor_id === 'string') &&
      rForkTurns[0]?.provider_anchor_id === null,
    {
      main: rTurns.map((t) => `${t.status}:${t.provider_anchor_id}`),
      fork: rForkTurns.map((t) => `${t.status}:${t.provider_anchor_id}`)
    }
  )

  // And the renderer, off the restored rows: reopen the case from scratch.
  await openCase()
  await switchTo(false)
  const restoredText = await waitFor(
    'the restored transcript to render',
    async () => {
      const t = await body()
      // §5's two turns and §6b's probe all point at T1, so they render as ONE divider.
      return t.includes('Rewound 3 turns') ? t : null
    },
    30000
  ).catch(() => null)
  check(
    'the restored transcript shows both rewinds at T1 as one "Rewound 3 turns" divider',
    Boolean(restoredText),
    restoredText ? 'present' : await body()
  )
  await switchTo(true)
  const restoredForkText = await waitFor(
    'the restored fork transcript to render',
    async () => {
      const t = await body()
      return t.includes('Forked from chat') ? t : null
    },
    30000
  ).catch(() => null)
  check(
    'the restored fork still shows its divider, repointed at the restored parent',
    Boolean(restoredForkText) && restoredForkText.includes(`Forked from chat ${rMain.id}`),
    restoredForkText
      ? restoredForkText.split('\n').find((l) => l.includes('Forked from chat'))
      : 'no divider'
  )

  conn.close()
  report()
}

main().catch((e) => {
  console.error('GATE ERROR', e)
  process.exit(1)
})
