#!/usr/bin/env node
/**
 * Skill-asset run gate — the one live gate for spec §11 (multi-file skills, increment 3).
 *
 * jsdom cannot see this path at all: there is no main process, no skills junction, no real
 * classifier and no `skill_asset_reviews` table behind a renderer test. This drives the REAL
 * app over CDP against a scratch ARGUS_HOME and proves increments 1, 2 and 3 join up —
 *
 *   inc 1  a directory-shaped proposal carrying `scripts/collect.sh` is accepted through the
 *          UI, which is what writes the `skill_asset_reviews` row,
 *   inc 2  the queue card flags the executable and the file rail lists the script,
 *   inc 3  running that script through a real agent turn opens a HIGH approval whose notice
 *          names the skill, the file and the review state, with the script body one click away.
 *
 * The review row deliberately comes from a HUMAN ACCEPT through the UI, never an INSERT: the
 * whole claim of the `reviewed on this machine` check is that the accept path and the run gate
 * agree about which bytes were approved. An inserted row would make the check pass while
 * proving nothing.
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9249
 *   2. ARGUS_HOME=<scratch> CDP_PORT=9249 node scripts/cdp-skill-run-gate.mjs
 *
 * Costs real Claude tokens: three short agent turns, each denied at the approval card, so the
 * script never actually executes. Exits 0 when every check passes, 1 otherwise, 2 when the
 * IDENTITY assertion fails — see `argus-cdp-port-collision` and `argus-vacuous-live-assertions`:
 * two prior sessions in this project passed a CDP gate for the wrong reason, once by driving a
 * different branch's app on a shared port and once by asserting on the wrong screen. The
 * identity assertion below is a filesystem-level proof, not a name match: the proposal is
 * written into OUR scratch home with `fs`, and the app must list it back. An app booted against
 * any other home cannot.
 */
import fs from 'node:fs'
import path from 'node:path'
import { listTargets, connect, mainWindow, sleep, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9249'
const HOME = process.env.ARGUS_HOME
if (!HOME) {
  console.error('ARGUS_HOME is required (the scratch home the app was booted against)')
  process.exit(2)
}

const SLUG = 'skill-run-gate'
const SKILL = 'collect-logs'
const SKILL_REL = 'scripts/collect.sh'
const SECOND_SKILL = 'never-seen'
const SECOND_REL = 'scripts/probe.sh'
const TITLE = 'Add a collect-logs skill that ships its own collection script'

/** Distinctive enough that finding it in the card's own `<pre>` can only mean the file's bytes
 *  reached the DOM — it appears nowhere else in the app, the prompt, or the command line. */
const MARKER = 'ARGUS-SKILL-RUN-GATE-9f21c7'
const ECHO_LINE = `echo "${MARKER}: collecting logs"`
const CHANGED_LINE = `echo "${MARKER}: line appended after the human reviewed these bytes"`
const SCRIPT_BODY = ['#!/bin/sh', '# seeded by scripts/cdp-skill-run-gate.mjs', ECHO_LINE, ''].join(
  '\n'
)
const SECOND_BODY = ['#!/bin/sh', `echo "${MARKER}: never-seen probe"`, ''].join('\n')

const SKILL_MD_BODY = [
  '---',
  `name: ${SKILL}`,
  'description: Collect diagnostic logs for a case by running the bundled collection script.',
  '---',
  '',
  '# Collect logs',
  '',
  `Run \`${SKILL_REL}\` to gather the logs for this case.`,
  ''
].join('\n')

const userSkillsDir = path.join(HOME, 'skills-user')
/** Where the bytes actually live — what this script writes, appends to and reads back. */
const scriptAbs = path.join(userSkillsDir, SKILL, ...SKILL_REL.split('/'))
const secondScriptAbs = path.join(userSkillsDir, SECOND_SKILL, ...SECOND_REL.split('/'))

/**
 * What the AGENT is asked to run: the per-case junction `materializeSessionSkills` builds,
 * relative to the session cwd (the case directory).
 *
 * Two reasons this is not the absolute `skills-user/...` path. It is the path a skill's script
 * is actually invoked by in production, so it exercises the junction-following half of
 * `skillAssetAt` — the half whose comment says matching the literal path would find nothing.
 * And `skills-user` is outside the agent's sandbox: asked to run something there it cannot even
 * read, the model correctly refuses and the gate times out with no card (observed live
 * 2026-08-20). The prompt is deliberately plain for the same reason — an earlier version said
 * "do not read the file first", which reads as an attempt to smuggle an unvetted payload past
 * exactly the gate under test, and the model declined to run it at all.
 */
const linkRel = (skill, rel) => `.claude/skills/${skill}/${rel}`

// ---------- seed: a directory-shaped proposal, in writeProposal's own layout ----------
/**
 * Layout taken from `writeProposal` in `app/src/main/services/proposals.ts` (the `files.length
 * > 0` branch): the entry is a DIRECTORY under `<home>/proposals/`, named
 * `<yyyy-mm-dd>-<caseSlug>-<target>` with NO `.md` suffix (a directory ending in `.md` is
 * refused outright); the frontmatter + body live in `<dir>/SKILL.md`; siblings live at their
 * own relative paths beneath the directory.
 *
 * Built in a staging directory and renamed into place: `proposalsWatch` is a NON-recursive
 * `fs.watch`, so a directory created empty fires its event before SKILL.md exists —
 * `scanProposalDir` skips a directory with no SKILL.md, and no later event would arrive for a
 * write inside it. One rename means the app only ever sees the finished tree.
 */
function seedProposal() {
  const dir = path.join(HOME, 'proposals')
  fs.mkdirSync(dir, { recursive: true })
  const name = `${new Date().toISOString().slice(0, 10)}-${SLUG}-${SKILL}`
  const dest = path.join(dir, name)
  const staging = path.join(HOME, `.gate-staging-${process.pid}`)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(path.join(staging, 'scripts'), { recursive: true })
  const fm = [
    '---',
    'type: skill-new',
    `target: ${SKILL}`,
    `case: ${SLUG}`,
    `date: ${new Date().toISOString()}`,
    `title: ${TITLE}`,
    'status: pending',
    '---',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(staging, 'SKILL.md'), fm + SKILL_MD_BODY)
  fs.writeFileSync(path.join(staging, 'scripts', 'collect.sh'), SCRIPT_BODY)
  fs.renameSync(staging, dest)
  return name
}

/** An imported / HiveMind-pulled skill: bytes on disk, no proposal, no review row. */
function seedUnreviewedSkill() {
  const root = path.join(userSkillsDir, SECOND_SKILL)
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'SKILL.md'),
    [
      '---',
      `name: ${SECOND_SKILL}`,
      'description: A skill that arrived from somewhere else and was never reviewed here.',
      '---',
      '',
      '# Never seen',
      '',
      `Run \`${SECOND_REL}\`.`,
      ''
    ].join('\n')
  )
  fs.writeFileSync(secondScriptAbs, SECOND_BODY)
}

// ---------- page helpers ----------
const NOTICE_SEL = '[data-testid="skill-asset-notice"]'

let conn

const evalJs = (expr) => conn.evalJs(expr)

const click = (sel) =>
  evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    el.click()
    return true
  })()`)

/**
 * Everything the checks need about the approval card, read from the card that OWNS the
 * skill-asset notice — never from `document.body`. A body-wide text search would also match the
 * chat transcript, the tool-call card and the command line the model echoed back, so it would
 * keep passing with the notice deleted. `notice.parentElement` is the ApprovalCard root
 * (`ApprovalCard.tsx` renders `<SkillAssetNotice/>` as a direct child).
 */
const cardInfo = () =>
  evalJs(`(() => {
    const n = document.querySelector(${JSON.stringify(NOTICE_SEL)})
    if (!n) return null
    const card = n.parentElement
    const header = card.children[0]
    const chips = [...header.querySelectorAll('span')].map((s) => s.textContent.trim())
    const bodyPre = n.querySelector('pre')
    return {
      noticeText: n.innerText,
      chips,
      buttons: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()),
      // The card's own args preview is a DIRECT child <pre>; the notice's script <pre> is
      // nested inside the notice, so the two can never be confused.
      argsPreview: ([...card.children].find((e) => e.tagName === 'PRE') || {}).innerText || null,
      scriptBody: bodyPre ? bodyPre.innerText : null
    }
  })()`)

/** Click every open approval card's Deny. Returns how many were clicked. */
const denyAll = () =>
  evalJs(`(() => {
    const bs = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Deny')
    bs.forEach((b) => b.click())
    return bs.length
  })()`)

/** Deny only the approval cards that are NOT the skill-asset one — see
 *  `runScriptAndCaptureCard`. Returns how many were clicked. */
const denyOthers = () =>
  evalJs(`(() => {
    const bs = [...document.querySelectorAll('button')]
      .filter((b) => b.textContent.trim() === 'Deny')
      .filter((b) => {
        const card = b.parentElement && b.parentElement.parentElement
        return !card || !card.querySelector(${JSON.stringify(NOTICE_SEL)})
      })
    bs.forEach((b) => b.click())
    return bs.length
  })()`)

const composerIdle = () => evalJs(`!!document.querySelector('button[aria-label="Send"]')`)

/**
 * The button whose `aria-label` is exactly `label`, found by walking the buttons rather than
 * with an attribute selector: the labels here carry the proposal TITLE, whose apostrophes and
 * spaces would have to be escaped into a CSS string correctly at two nesting levels. A JS
 * comparison against a `JSON.stringify`d literal has no such trap.
 */
const byLabel = (label, action) =>
  evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.getAttribute('aria-label') || '') === ${JSON.stringify(label)}
    )
    if (!b) return null
    ${action}
  })()`)

const labelText = (label) => byLabel(label, `return b.innerText`)
const clickLabel = (label) => byLabel(label, `if (b.disabled) return false; b.click(); return true`)

/** Deny anything outstanding and wait for the turn to end. */
async function settleTurn(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const denied = await denyAll()
    if (denied === 0 && (await composerIdle())) return true
    await sleep(600)
  }
  return false
}

async function sendPrompt(text) {
  const focused = await evalJs(`(() => {
    const ta = document.querySelector('textarea[placeholder^="Message the analyst"]')
    if (!ta) return false
    ta.focus()
    return document.activeElement === ta
  })()`)
  if (!focused) throw new Error('composer textarea not found (is the case view open?)')
  await conn.insertText(text)
  await sleep(400)
  const len = await evalJs(
    `(document.querySelector('textarea[placeholder^="Message the analyst"]') || {}).value?.length ?? 0`
  )
  if (!len) throw new Error('composer did not take the typed text')
  const sent = await evalJs(`(() => {
    const b = document.querySelector('button[aria-label="Send"]')
    if (!b || b.disabled) return false
    b.click()
    return true
  })()`)
  if (!sent) throw new Error('Send button missing or disabled')
}

/**
 * Start a fresh chat, through the switcher's own "New chat" control.
 *
 * Each of the three runs gets its own session, and NOT for tidiness: every run ends in a deny,
 * and a model that has already been refused twice in the same conversation reasonably stops
 * re-issuing the command — which surfaces as this gate timing out with no card, on the second
 * run of the second invocation. Observed live 2026-08-20. A fresh session also means the three
 * review states are asserted independently rather than as one long transcript.
 */
async function newChat() {
  if (!(await click('button[aria-label="Switch chat"]'))) throw new Error('chat switcher missing')
  await sleep(600)
  const created = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.getAttribute('aria-label') || '') === 'New chat'
    )
    if (!b) return false
    b.click()
    return true
  })()`)
  if (!created) throw new Error('"New chat" control missing from the chat switcher')
  await sleep(1500)
  await waitFor('composer ready on the new chat', composerIdle, 30_000)
}

/**
 * Ask the agent to run one script and return the approval card that opens for it.
 *
 * Unrelated approvals (the model reaching for a different tool first) are denied while waiting
 * rather than left open, because an open card blocks the turn and the wait would time out with
 * nothing to show for it. `denyOthers`, never `denyAll`: the card under test can open in the
 * round trip between the `cardInfo()` poll and the deny, and denying it would leave this loop
 * waiting for a request that will never come back.
 */
async function runScriptAndCaptureCard(relScript, timeoutMs = 300_000) {
  const cmd = `sh ${relScript}`
  await newChat()
  // Never assert on a card that was already on screen. Without this the second and third runs
  // could return the PREVIOUS request's notice the instant they start polling, and the review
  // state they assert would be the state from before the bytes changed — a pass for the wrong
  // reason, and the exact failure mode this gate exists to avoid elsewhere.
  if (await evalJs(`!!document.querySelector(${JSON.stringify(NOTICE_SEL)})`)) {
    throw new Error('a skill-asset approval card was already open before this run started')
  }
  await sendPrompt(`Please run this command for this case with your shell tool: ${cmd}`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = await cardInfo()
    if (info) return info
    const others = await denyOthers()
    if (others > 0) console.error(`  (denied ${others} unrelated approval card(s) while waiting)`)
    await sleep(500)
  }
  throw new Error(`timed out waiting for a skill-asset approval card for: ${cmd}`)
}

/** Open the notice's "Show script" disclosure and re-read the card. */
async function showScript() {
  const clicked = await evalJs(`(() => {
    const n = document.querySelector(${JSON.stringify(NOTICE_SEL)})
    if (!n) return false
    const b = [...n.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Show script')
    if (!b) return false
    b.click()
    return true
  })()`)
  await sleep(400)
  return clicked ? cardInfo() : null
}

/**
 * ⚠ DUPLICATE OF PRODUCT LOGIC — `shellSegments()` in
 * `app/src/main/services/agent/risk.ts`. Keep the two byte-identical.
 *
 * A CDP gate is a black box: it drives the built app over a socket and cannot import from `src/`,
 * so this rule necessarily exists twice. It cannot be made safe, only LOUD — hence this banner.
 * It has already drifted once: the newline separator landed in `d51f4963` and this copy did not
 * follow, which would have failed the check below the first time the model wrote a multi-line
 * command (caught by reading the diff, not by a red run — the run that round happened to be
 * single-line).
 *
 * **Symptom of drift: this check fails on a command that is actually fine.** That is a RED, never
 * a false green — the check compares two independently-derived facts (the button the app rendered
 * vs. the segment count derived here), so a stale copy makes them disagree and the gate says so.
 * Annoying, not dangerous. Do not "fix" a failure here by relaxing the check; re-read
 * `shellSegments()` and re-sync.
 *
 * Three behaviours to mirror, all three load-bearing:
 *   1. Join `\`+newline into a space FIRST — a line continuation is formatting, not a separator
 *      (`b2684609`). Splitting first puts a continued flag in its own segment.
 *   2. Test the heredoc marker against the JOINED string, for the same reason.
 *   3. Split on newline too, EXCEPT when a heredoc is open — inside `cat <<'EOF' … EOF` the lines
 *      are data, not statements (`d51f4963`).
 * Then drop empty segments, so a trailing `;` does not cost an ordinary invocation its key.
 *
 * What it counts is the quantity `classifyToolCall` keys the session grant on: a key is offered
 * for one segment and refused for more, because the key is computed per segment but applied to
 * the whole command.
 */
const HEREDOC_OPEN = /(?<!<)<<(?!<)-?[ \t]*["'\\]?[A-Za-z_]/

const meaningfulSegments = (command) => {
  const joined = command.replace(/\\\r?\n/g, ' ')
  return joined
    .split(HEREDOC_OPEN.test(joined) ? /&&|\|\||;|\|/ : /&&|\|\||;|\||\r?\n/)
    .filter((s) => s.trim() !== '').length
}

/** A fresh ARGUS_HOME opens the setup wizard, whose overlay swallows every click behind it. */
const dismissOnboarding = () =>
  evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Skip setup')
    if (!b) return false
    b.click()
    return true
  })()`)

async function openCase(slug) {
  await click('button[aria-label="All cases"]')
  await sleep(800)
  // The slug is a plain <span> on the card (CaseCard.tsx); `.case-card` is the card root, and
  // scoping the text match to a descendant of one keeps a slug mentioned elsewhere on the page
  // from being clicked instead.
  const opened = await evalJs(`(() => {
    const el = [...document.querySelectorAll('span')].find(
      (e) => e.textContent.trim() === ${JSON.stringify(slug)} && e.closest('.case-card')
    )
    const card = el && el.closest('.case-card')
    if (!card) return false
    card.click()
    return true
  })()`)
  if (!opened) throw new Error(`no case card for ${slug} on the home grid`)
  await waitFor(`case view (${slug})`, () =>
    evalJs(`!!document.querySelector('[data-testid="dynamic-case"]')`)
  )
  await waitFor('composer ready', composerIdle, 30_000)
}

// ---------- the gate ----------
const main = async () => {
  const proposalName = seedProposal()
  console.error(`seeded proposal ${proposalName} under ${path.join(HOME, 'proposals')}`)

  const targets = await waitFor(
    `a page target on ${PORT}`,
    async () => {
      const t = await listTargets(PORT).catch(() => [])
      return t.length ? t : null
    },
    30_000
  )
  conn = await connect(mainWindow(targets))
  console.error(`connected to ${PORT}: ${targets.map((t) => t.url).join(', ')}`)
  if (await dismissOnboarding()) console.error('dismissed the setup wizard')

  // ---- IDENTITY, before anything else ----
  // Not a name match: this proposal directory was written by THIS process into THIS scratch
  // home with `fs`. An app booted against any other ARGUS_HOME — another branch's window that
  // happens to own the port — physically cannot list it.
  const seen = await waitFor(
    'the app to list our seeded proposal',
    async () => {
      const payload = await evalJs(`window.argus.proposals.list()`)
      return (payload?.proposals ?? []).find((p) => p.file === proposalName) ?? null
    },
    20_000
  ).catch(() => null)
  if (!seen) {
    console.error(
      `IDENTITY FAIL: the app on port ${PORT} does not list ${proposalName}, so it is not reading ${HOME}. Refusing to continue.`
    )
    process.exit(2)
  }
  check('identity: the app on this port is reading our scratch ARGUS_HOME', true, {
    port: PORT,
    home: HOME,
    proposal: seen.file
  })

  // The case the chat runs in. Created through the app's own IPC so the on-disk case dir
  // exists (the agent session's cwd).
  const cases = await evalJs(`window.argus.cases.list()`)
  if (!(cases ?? []).some((c) => c.slug === SLUG)) {
    await evalJs(
      `window.argus.cases.create(${JSON.stringify({ slug: SLUG, title: 'Skill-asset run gate fixture' })})`
    )
    await sleep(1500)
  }

  // ---- 1. the queue and the rail, BEFORE accepting (increment 2) ----
  await click('button[aria-label="Proposals"]')
  const rowText = await waitFor('the proposal row in the queue', () =>
    labelText(`Select proposal ${TITLE}`)
  )
  check(
    'queue card flags the executable',
    typeof rowText === 'string' && /\bexec\b/i.test(rowText),
    rowText
  )

  await clickLabel(`Select proposal ${TITLE}`)
  await sleep(900)
  const railTabs = await evalJs(`(() => {
    const rail = document.querySelector('[role="tablist"][aria-label="Files in this proposal"]')
    return rail ? [...rail.querySelectorAll('[role="tab"]')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim()) : null
  })()`)
  check(
    'rail lists the script',
    Array.isArray(railTabs) && railTabs.some((t) => t.includes(SKILL_REL)),
    railTabs
  )

  // ---- 2. accept it, through the UI ----
  const accepted = await clickLabel(`Accept ${TITLE}`)
  if (accepted !== true) throw new Error(`Accept button missing or disabled (got ${accepted})`)
  await sleep(2500)

  // ---- 3. the skill landed on disk with the seeded bytes ----
  const onDisk = fs.existsSync(scriptAbs) ? fs.readFileSync(scriptAbs, 'utf8') : null
  check('skill landed on disk', onDisk === SCRIPT_BODY, {
    path: scriptAbs,
    bytes: onDisk === null ? null : onDisk.length,
    identical: onDisk === SCRIPT_BODY
  })

  // ---- 4. run it: the reviewed case ----
  await openCase(SLUG)
  const reviewed = await runScriptAndCaptureCard(linkRel(SKILL, SKILL_REL))
  console.error(`card (reviewed): ${JSON.stringify(reviewed, null, 2)}`)
  check('card is HIGH', reviewed.chips.includes('HIGH'), reviewed.chips)
  check(
    'card names the skill and file',
    reviewed.noticeText.includes(SKILL) && reviewed.noticeText.includes(SKILL_REL),
    reviewed.noticeText
  )
  check(
    'card says reviewed on this machine',
    reviewed.noticeText.includes('reviewed on this machine'),
    reviewed.noticeText
  )
  check('script body is not shown until asked', reviewed.scriptBody === null, reviewed.scriptBody)
  const opened = await showScript()
  check(
    'script body is one click away',
    Boolean(opened && opened.scriptBody && opened.scriptBody.includes(ECHO_LINE)),
    opened?.scriptBody
  )
  // Both directions, because the model decides the shape of the command and the gate does not.
  // Asserting only "the button is present" made this check fail whenever the model wrapped the
  // invocation in its own `cd … &&` — which it does spontaneously, roughly half the time — even
  // though hiding the grant on a chained command is exactly the intended behaviour. Prompting the
  // model out of chaining is not the fix: the wording that would take is the wording that made it
  // refuse to run the script at all (see `runScriptAndCaptureCard`).
  const segments = meaningfulSegments(reviewed.argsPreview ?? '')
  const grantOffered = reviewed.buttons.includes('Approve for session')
  check(
    'session grant offered exactly when the command is one segment',
    grantOffered === (segments === 1),
    { segments, grantOffered, command: reviewed.argsPreview }
  )

  // ---- 5. change the bytes on disk, run again ----
  if (!(await settleTurn())) throw new Error('turn never settled after the reviewed run')
  fs.appendFileSync(scriptAbs, `${CHANGED_LINE}\n`)
  console.error(`appended a line to ${scriptAbs}`)
  const changed = await runScriptAndCaptureCard(linkRel(SKILL, SKILL_REL))
  console.error(`card (changed): ${JSON.stringify(changed.noticeText)}`)
  check(
    'card says changed since you reviewed it',
    changed.noticeText.includes('CHANGED since you reviewed it'),
    changed.noticeText
  )

  // ---- 6. a skill that arrived without a proposal ----
  if (!(await settleTurn())) throw new Error('turn never settled after the changed run')
  seedUnreviewedSkill()
  const unreviewed = await runScriptAndCaptureCard(linkRel(SECOND_SKILL, SECOND_REL))
  console.error(`card (unreviewed): ${JSON.stringify(unreviewed.noticeText)}`)
  check(
    'card says never reviewed here',
    unreviewed.noticeText.includes('never reviewed here') &&
      unreviewed.noticeText.includes(SECOND_SKILL),
    unreviewed.noticeText
  )
  await settleTurn(60_000)

  conn.close()
  report()
}

main().catch((e) => {
  console.error('GATE ERROR', e)
  process.exit(1)
})
