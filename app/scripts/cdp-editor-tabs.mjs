#!/usr/bin/env node
/**
 * The tabbed-editor runtime gate (spec §6.1, §6.2, §8.2, and §8.3 step 5 extended to a tab SET).
 *
 * Everything here is out of vitest's reach by construction (§8.2), and this increment widened
 * that gap rather than narrowing it:
 *
 *   - `CodeSurface` is MOCKED as a `<textarea>` in every renderer test, because CodeMirror
 *     measures real DOM and jsdom has none — it throws `getClientRects is not a function` on
 *     mount. So nothing in the unit suite has ever seen a real surface, let alone N of them.
 *   - jsdom applies NO CSS. Inactive tabs are hidden by swapping the whole Tailwind class string
 *     to `hidden`; a refactor to the HTML `hidden` ATTRIBUTE would fail silently, because
 *     `[hidden]` is a UA rule at effectively zero specificity and the wrapper's `.flex` beats it.
 *     Only a styled window can tell those two apart.
 *   - The `readOnly` Compartment's WIRING has no coverage at all: gutting the body of
 *     `CodeSurface`'s reconfigure effect leaves all 505 renderer tests green. `setup.test.ts`
 *     proves the compartment's state semantics; nothing proves the component ever calls it.
 *
 * ── The fixture ───────────────────────────────────────────────────────────────────────────────
 *
 * Run the `seed` phase first — it writes the whole scratch home and needs no app:
 *
 *   ARGUS_HOME=/tmp/argus-tabs-gate node scripts/cdp-editor-tabs.mjs seed
 *
 * It creates THREE user skills (`gate-alpha`, `gate-beta` — the two editable tabs — and
 * `gate-spare`, whose only job is to be re-saved through `skills:write` to make main broadcast
 * `skills:changed` without touching an open tab), ONE hivemind skill (`gate-locked`, the
 * read-only + *Edit a copy* path) and ONE hivemind reference (`gate-locked-ref.md`, the other
 * branch of `isAssetEditable`). `config/settings.json` gets `onboarding.completedAt` so the
 * first-run wizard does not cover the Library. `gate-alpha` and `gate-beta` are deliberately
 * DIFFERENT lengths, so "the cursor came back on the line it was on" cannot pass by coincidence.
 *
 * ── The run ───────────────────────────────────────────────────────────────────────────────────
 *
 *   1. ARGUS_HOME=/tmp/argus-tabs-gate npx electron-vite dev --remoteDebuggingPort 9223
 *      ARGUS_HOME=/tmp/argus-tabs-gate node scripts/cdp-editor-tabs.mjs        # (phase `main`)
 *   2. the app quits at the end of phase 1 — relaunch it exactly as above, then
 *      ARGUS_HOME=/tmp/argus-tabs-gate node scripts/cdp-editor-tabs.mjs restore
 *
 * Two phases because the assertion between them IS a process death (same reason as
 * `cdp-editor-drafts.mjs`). Re-run `seed` before re-running `main`: `main` deliberately leaves
 * drafts and a persisted tab set armed for `restore`, and it saves through the app's own Save,
 * which legitimately changes a file on disk. What the SCRIPT itself writes — the directory move
 * that flips a tier — is restored in a `finally`.
 *
 * No assist provider is needed (unlike `cdp-editor-surface.mjs`): nothing here runs Draft or
 * Improve.
 *
 * Env: CDP_PORT (default 9223), ARGUS_HOME (required).
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  listTargets as list,
  connect,
  sleep,
  waitFor,
  check,
  report,
  VISIBLE_SURFACE,
  VISIBLE_PANEL,
  clickTab,
  focusVisibleEnd,
  mainWindow,
  toEditorMode
} from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9223'
const HOME = process.env.ARGUS_HOME
const PHASE = process.argv[2] ?? 'main'

const ALPHA = 'gate-alpha'
const BETA = 'gate-beta'
const SPARE = 'gate-spare'
const LOCKED = 'gate-locked'
const LOCKED_COPY = 'gate-locked-copy'
const LOCKED_REF = 'gate-locked-ref.md'

const MARKER_A = 'CDP-TABS-MARKER-A'
const MARKER_B = 'CDP-TABS-MARKER-B'
const REFUSED = 'CDP-TABS-SHOULD-NOT-APPEAR'
const ARM_A = 'CDP-TABS-ARM-A'
const ARM_B = 'CDP-TABS-ARM-B'

if (!HOME) {
  console.error('ARGUS_HOME must be set to the same scratch home the app was booted with')
  process.exit(1)
}
if (PHASE !== 'seed' && PHASE !== 'main' && PHASE !== 'restore') {
  console.error('usage: cdp-editor-tabs.mjs seed|main|restore')
  process.exit(1)
}

const userSkill = (name) => path.join(HOME, 'skills-user', name)
const hiveSkill = (name) => path.join(HOME, 'skills-hivemind', name)
const skillFile = (dir) => path.join(dir, 'SKILL.md')
const stateFile = path.join(HOME, '.cdp-tabs-gate-state.json')
const tabsFile = path.join(HOME, 'config', 'editor-window.json')

// ── seed ──────────────────────────────────────────────────────────────────────────────────────

if (PHASE === 'seed') {
  const skill = (name, bodyLines) =>
    `---\nname: ${name}\ndescription: Fixture skill for the tabs runtime gate (${name}).\n---\n\n# ${name}\n\n` +
    bodyLines.map((l) => `${l}\n`).join('')

  fs.rmSync(HOME, { recursive: true, force: true })
  fs.mkdirSync(path.join(HOME, 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(HOME, 'config', 'settings.json'),
    JSON.stringify(
      { onboarding: { completedAt: '2026-01-01T00:00:00.000Z', phase1Done: true, tourDone: true } },
      null,
      2
    )
  )
  // Different lengths on purpose — see the header note on the restored cursor.
  fs.mkdirSync(userSkill(ALPHA), { recursive: true })
  fs.writeFileSync(
    skillFile(userSkill(ALPHA)),
    skill(ALPHA, ['Alpha line one.', 'Alpha line two.'])
  )
  fs.mkdirSync(userSkill(BETA), { recursive: true })
  fs.writeFileSync(
    skillFile(userSkill(BETA)),
    skill(BETA, ['Beta line one.', 'Beta line two.', 'Beta line three.', 'Beta line four.'])
  )
  fs.mkdirSync(userSkill(SPARE), { recursive: true })
  fs.writeFileSync(skillFile(userSkill(SPARE)), skill(SPARE, ['Spare. Never opened in a tab.']))
  fs.mkdirSync(hiveSkill(LOCKED), { recursive: true })
  fs.writeFileSync(skillFile(hiveSkill(LOCKED)), skill(LOCKED, ['Locked. Opens read-only.']))
  fs.mkdirSync(path.join(HOME, 'references'), { recursive: true })
  fs.writeFileSync(
    path.join(HOME, 'references', LOCKED_REF),
    '---\ntrust_tier: hivemind\n---\n\n# locked reference\n\nInstalled from HiveMind, so read-only.\n'
  )
  console.error(
    `seeded ${HOME}\n\nnow boot:\n  ARGUS_HOME=${HOME} npx electron-vite dev --remoteDebuggingPort ${PORT}`
  )
  process.exit(0)
}

// ── shared plumbing ───────────────────────────────────────────────────────────────────────────

const listTargets = () => list(PORT)

/** The Library lives behind the settings gear — same poll-and-reclick as the other three gates:
 *  the settings payload and the skills list both load async, so a single click can land before
 *  the nav exists. Idempotent either way. */
const gotoLibrary = async (main) => {
  await waitFor(
    'the Library page with a user-tier Edit button',
    async () => {
      if (await main.evalJs(`!!document.querySelector('[aria-label^="Edit \\u00b7 "]')`))
        return true
      await main.evalJs(`(() => {
        const gear = document.querySelector('button[aria-label="Settings"]')
        if (gear && !document.querySelector('nav[aria-label="Settings sections"]')) gear.click()
        const nav = document.querySelector('nav[aria-label="Settings sections"]')
        const lib = nav && [...nav.querySelectorAll('button')]
          .find(b => (b.textContent || '').trim() === 'Library')
        if (lib) lib.click()
        return 1
      })()`)
      return false
    },
    30000
  )
}

/** Open (or focus) the editor on an asset through the same IPC the Library's Edit button calls.
 *  The Library only renders Edit for assets it considers yours, so a read-only asset has no
 *  button — this is the only route to one, and it is the product's own. */
const openAsset = (main, kind, name) =>
  main.evalJs(
    `window.argus.editor.open({ kind: ${JSON.stringify(kind)}, name: ${JSON.stringify(name)}, mode: 'edit' }).then(() => true)`
  )

const visibleDoc = (conn) =>
  conn.evalJs(`(() => { const e = ${VISIBLE_SURFACE}; return e ? e.innerText : null })()`)

const visibleEditable = (conn) =>
  conn.evalJs(
    `(() => { const e = ${VISIBLE_SURFACE}; return e ? e.getAttribute('contenteditable') : null })()`
  )

/** Text of every `role="status"` banner inside the visible pane. The hidden panes have their own
 *  and they are all in the DOM at once (spec §6.1), so an unscoped query reads another tab's. */
const visibleStatus = (conn) =>
  conn.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    if (!p) return null
    return Array.from(p.querySelectorAll('[role="status"]')).map((n) => n.textContent).join(' | ')
  })()`)

/** Click a button by its text, scoped to the visible pane — same reason as `visibleStatus`. */
const clickInPane = (conn, re) =>
  conn.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    if (!p) return false
    const b = Array.from(p.querySelectorAll('button')).find((x) => ${re}.test((x.textContent || '').trim()))
    if (!b) return false
    b.click()
    return true
  })()`)

const tabLabels = (conn) =>
  conn.evalJs(
    `Array.from(document.querySelectorAll('[role="tab"]')).map((t) => t.getAttribute('aria-label'))`
  )

const surfaceCount = (conn) => conn.evalJs(`document.querySelectorAll('.cm-content').length`)

/** Drop DOM focus to <body>, which is where Preview mode's `inert` puts it. The window-level
 *  Ctrl+S fallback is only reachable from there — CodeMirror's own keymap handles the chord
 *  while the surface has focus, so testing the fallback means leaving it. */
const blurAll = (conn) =>
  conn.evalJs(
    `(() => { if (document.activeElement) document.activeElement.blur(); return document.activeElement === document.body })()`
  )

const ctrlS = (conn) => conn.key('s', { modifiers: 2, code: 'KeyS', keyCode: 83 })
const ctrlZ = (conn) => conn.key('z', { modifiers: 2, code: 'KeyZ', keyCode: 90 })

/** Line:col out of the visible pane's status bar. */
const visibleCursor = (conn) =>
  conn.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    if (!p) return null
    return Array.from(p.querySelectorAll('span')).map((s) => s.textContent).find((t) => /^\\d+:\\d+$/.test(t || '')) || null
  })()`)

/** Make main re-read the skill dirs and broadcast `skills:changed` to every window — the signal
 *  `useAssetTiers` listens to, and therefore the only way to flip a MOUNTED tab's `readOnly`.
 *  Re-saves `gate-spare`, which no tab has open, so nothing under test is disturbed. */
const broadcastSkillsChanged = (main) =>
  main.evalJs(`(async () => {
    const r = await window.argus.skills.read(${JSON.stringify(SPARE)})
    await window.argus.skills.write(${JSON.stringify(SPARE)}, r.content, r.hash)
    return true
  })()`)

/** Connect to the main window and prove it is THIS fixture. Every worktree's dev instance can be
 *  running at once; a busy debug port still answers `/json/list`, with the OTHER instance's
 *  window, and nothing in the response says so. Asking for a skill only this fixture has is the
 *  cheapest way to refuse to drive someone else's app. */
const connectMain = async () => {
  const main = await connect(mainWindow(await listTargets()))
  const names = await main.evalJs(
    `window.argus.skills.list().then((p) => p.skills.map((s) => s.name))`
  )
  if (!Array.isArray(names) || !names.includes(ALPHA)) {
    console.error(
      `the app on port ${PORT} is not the fixture this gate seeded (no "${ALPHA}" skill).\n` +
        `Its skills: ${JSON.stringify(names)}\nRefusing to drive it. Boot with ARGUS_HOME=${HOME}.`
    )
    process.exit(1)
  }
  return main
}

const openEditorWindow = async () => {
  let target = null
  await waitFor('the editor window', async () => {
    target = (await listTargets()).find((t) => t.url.includes('editor.html'))
    return !!target
  })
  const editor = await connect(target)
  await waitFor('the CodeMirror surface to render', async () => (await surfaceCount(editor)) > 0)
  // `viewMode` is persisted, so a run that ended in Preview makes the next boot open in Preview —
  // where the surface is `inert` and every assertion below fails for the wrong reason.
  await toEditorMode(editor)
  return editor
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────

if (PHASE === 'main') {
  const main = await connectMain()
  await gotoLibrary(main)
  await main.evalJs(`document.querySelector('[aria-label="Edit \\u00b7 ${ALPHA}"]').click()`)
  const editor = await openEditorWindow()

  // Everything from here down runs inside try/finally: the read-only assertions MOVE a skill
  // directory between tiers, and a failed `waitFor` in between would otherwise leave the fixture
  // with `gate-alpha` stranded in skills-hivemind — where the Library shows no Edit button and
  // the next run cannot even start.
  let movedAlpha = false
  try {
    // ── 1. two tabs, both mounted (spec §6.1) ───────────────────────────────────────────────
    await openAsset(main, 'skill', BETA)
    const labels = await waitFor('two tabs in the strip', async () => {
      const l = await tabLabels(editor)
      return l.length === 2 ? l : false
    })
    check('two tabs are open', labels.length === 2, labels)
    const mounted = await waitFor('both surfaces to mount', async () =>
      (await surfaceCount(editor)) === 2 ? 2 : false
    )
    check('both tabs stay mounted at once', mounted === 2, mounted)

    // ── 2. the hidden pane is really hidden — the invariant only a comment guards ────────────
    // TabPane swaps the whole class string to `hidden` rather than toggling the `hidden`
    // ATTRIBUTE, because `[hidden]` is a UA rule at ~zero specificity and the wrapper's `.flex`
    // beats it: the "hidden" tab would render on top of the active one. jsdom has no CSS engine,
    // so no vitest assertion can tell the two implementations apart.
    const panes =
      await editor.evalJs(`(() => Array.from(document.querySelectorAll('[role="tabpanel"]'))
      .map((p) => ({ display: getComputedStyle(p).display, onScreen: p.offsetParent !== null })))()`)
    check('exactly one tab panel is on screen', panes.filter((p) => p.onScreen).length === 1, panes)
    check(
      'the inactive pane computes to display:none (not merely aria-hidden)',
      panes.filter((p) => !p.onScreen).every((p) => p.display === 'none'),
      panes
    )

    // ── 3. THE HEADLINE: undo survives a tab switch ─────────────────────────────────────────
    // The tab-level analogue of §8.3 step 3, and what "every tab stays mounted" actually buys.
    // If anything unmounted the surface on a switch, its history went with it and the Ctrl+Z
    // below is a silent no-op.
    check('switching to tab A', await clickTab(editor, ALPHA))
    await focusVisibleEnd(editor)
    await editor.insertText(`\n${MARKER_A}\n`)
    await waitFor('the marker in tab A', async () => (await visibleDoc(editor)).includes(MARKER_A))
    const before = await visibleDoc(editor)

    check('switching to tab B', await clickTab(editor, BETA))
    await waitFor('tab B on screen', async () => {
      const d = await visibleDoc(editor)
      return d !== null && !d.includes(MARKER_A)
    })
    check('switching back to tab A', await clickTab(editor, ALPHA))
    await waitFor('tab A back on screen', async () => (await visibleDoc(editor)).includes(MARKER_A))

    await editor.evalJs(`(() => { const e = ${VISIBLE_SURFACE}; if (e) e.focus(); return !!e })()`)
    await ctrlZ(editor)
    const after = await waitFor('the undo to land', async () => {
      const d = await visibleDoc(editor)
      return d.includes(MARKER_A) ? false : d
    })
    check('undo history survives a tab switch', !after.includes(MARKER_A))
    check('undo removed only the marker', before.replace(MARKER_A, '').trim() === after.trim())

    // ── 4. a revealed tab measures correctly ────────────────────────────────────────────────
    const geometry = await editor.evalJs(`(() => {
      const e = ${VISIBLE_SURFACE}
      if (!e) return null
      const scroller = e.closest('.cm-scroller')
      const gutter = scroller.querySelector('.cm-gutters')
      return {
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        gutterWidth: gutter ? gutter.getBoundingClientRect().width : 0
      }
    })()`)
    // A tab revealed from display:none without a `requestMeasure` comes back with a collapsed
    // viewport: zero-height scroller, zero-width gutter, no text past the first screenful.
    check(
      'a revealed tab has real geometry',
      geometry !== null && geometry.clientHeight > 0,
      geometry
    )
    check('a revealed tab has a measured gutter', geometry !== null && geometry.gutterWidth > 0)
    check(
      'a revealed tab can scroll its content',
      geometry !== null && geometry.scrollHeight >= geometry.clientHeight
    )

    // ── 5. the dirty count is real ──────────────────────────────────────────────────────────
    // The copy Increment 1 wrote and could never reach: it needs two genuinely dirty tabs and a
    // real close attempt on a real window.
    await focusVisibleEnd(editor)
    await editor.insertText(`\n${MARKER_A}\n`)
    check('switching to tab B to dirty it', await clickTab(editor, BETA))
    await focusVisibleEnd(editor)
    await editor.insertText(`\n${MARKER_B}\n`)
    await waitFor('both tabs to report dirty', async () => {
      const l = await tabLabels(editor)
      return l.filter((x) => x.includes('unsaved changes')).length === 2
    })
    await editor.evalJs(`window.close()`)
    const prompt = await waitFor('the close prompt', async () => {
      const t = await editor.evalJs(
        `(() => { const d = document.querySelector('[role="dialog"]'); return d ? d.textContent : null })()`
      )
      return t && /unsaved changes/i.test(t) ? t : false
    })
    check(
      'the close prompt counts both dirty tabs',
      /2 tabs have unsaved changes/.test(prompt),
      prompt
    )
    await editor.evalJs(`(() => {
      const d = document.querySelector('[role="dialog"]')
      const b = Array.from(d.querySelectorAll('button')).find((x) => /^cancel$/i.test(x.textContent.trim()))
      b.click()
      return true
    })()`)
    await waitFor('the prompt to close', async () =>
      editor.evalJs(`!document.querySelector('[role="dialog"]')`)
    )

    // ── 6. Ctrl+S reaches the ACTIVE tab, not the first-opened one ───────────────────────────
    // Every mounted pane registers its own `window` keydown listener. Before `active` gated them,
    // the FIRST-registered (oldest) pane handled the chord and called `preventDefault()`, so the
    // hidden tab got written while the visible dirty one did not. Focus has to be OUTSIDE
    // CodeMirror for this: its own keymap handles Ctrl+S while it has focus, and the window-level
    // fallback — the buggy path — is only reachable from <body>.
    check('switching to tab B before saving', await clickTab(editor, BETA))
    check('focus is outside the surface', await blurAll(editor))
    await ctrlS(editor)
    const savedActive = await waitFor(
      'the active tab to reach disk',
      () => fs.readFileSync(skillFile(userSkill(BETA)), 'utf8').includes(MARKER_B),
      10000
    ).catch(() => false)
    const alphaOnDisk = fs.readFileSync(skillFile(userSkill(ALPHA)), 'utf8')
    check('Ctrl+S saved the ACTIVE tab', savedActive === true, BETA)
    check(
      'Ctrl+S did not save the inactive tab',
      !alphaOnDisk.includes(MARKER_A),
      alphaOnDisk.slice(-40)
    )

    // ── 7. the readOnly Compartment is actually WIRED ────────────────────────────────────────
    // Move `gate-alpha` from skills-user to skills-hivemind, then make main broadcast
    // `skills:changed`. The tier for a MOUNTED, dirty, already-typed-in tab flips to hivemind,
    // and `CodeSurface` must reconfigure its compartment — without rebuilding the view, or the
    // document and undo history go with it. Gutting that effect leaves every renderer test green.
    check('switching to tab A before the tier flip', await clickTab(editor, ALPHA))
    fs.mkdirSync(path.dirname(hiveSkill(ALPHA)), { recursive: true })
    fs.renameSync(userSkill(ALPHA), hiveSkill(ALPHA))
    movedAlpha = true
    await broadcastSkillsChanged(main)
    const flipped = await waitFor(
      'the surface to go read-only',
      async () => (await visibleEditable(editor)) === 'false'
    ).catch(() => false)
    check('a live read-only flip reaches the DOM (contenteditable=false)', flipped === true)
    const afterFlip = await visibleDoc(editor)
    check(
      'the document survives the read-only flip (the view was reconfigured, not rebuilt)',
      afterFlip.includes(MARKER_A),
      afterFlip.slice(-40)
    )
    const flipStatus = (await visibleStatus(editor)) ?? ''
    check(
      'the read-only notice appears when the tier flips',
      /is read-only/.test(flipStatus),
      flipStatus
    )

    // Typing is REFUSED, not merely discouraged. The jsdom tests mock CodeSurface as a textarea,
    // so no test has ever put a keystroke into a read-only surface.
    await focusVisibleEnd(editor)
    await editor.insertText(REFUSED)
    await sleep(700)
    const afterTyping = await visibleDoc(editor)
    check('typing is refused on a read-only surface', !afterTyping.includes(REFUSED))

    // Save is genuinely unreachable. This is the assertion that would have caught the defect the
    // whole read-only feature fixes: `readSkill` returns the tier-winning copy while
    // `writeUserSkill` ALWAYS writes to skills-user, so saving a bundled/hivemind skill threw
    // `"x" changed on disk since you opened it` when nothing had changed on disk. `gate-alpha` no
    // longer has a skills-user copy, so a save that got through would recreate that exact path.
    check('focus is outside the surface for Ctrl+S', await blurAll(editor))
    await ctrlS(editor)
    await sleep(1500)
    check(
      'Ctrl+S on a read-only tab writes nothing to skills-user',
      !fs.existsSync(skillFile(userSkill(ALPHA)))
    )

    // Release it again — the direction the doc comment calls out for a post-claim pane — and only
    // NOW ask for the undo. `undo` refuses on a read-only state (@codemirror/commands checks
    // `state.readOnly`), so a Ctrl+Z while locked would prove nothing either way.
    fs.renameSync(hiveSkill(ALPHA), userSkill(ALPHA))
    movedAlpha = false
    await broadcastSkillsChanged(main)
    const released = await waitFor(
      'the surface to become editable again',
      async () => (await visibleEditable(editor)) === 'true'
    ).catch(() => false)
    check('releasing read-only makes the surface editable again', released === true)

    await editor.evalJs(`(() => { const e = ${VISIBLE_SURFACE}; if (e) e.focus(); return !!e })()`)
    await ctrlZ(editor)
    const afterRoundTrip = await waitFor(
      'the undo to land after the read-only round trip',
      async () => {
        const d = await visibleDoc(editor)
        return d.includes(MARKER_A) ? false : d
      }
    ).catch(() => null)
    check(
      'undo history survives a read-only round trip (a Compartment, not a remount)',
      afterRoundTrip !== null,
      afterRoundTrip === null ? 'the marker never went away' : afterRoundTrip.slice(-40)
    )
    check(
      'undo after the round trip removed only the marker',
      afterRoundTrip !== null && afterFlip.replace(MARKER_A, '').trim() === afterRoundTrip.trim()
    )

    // ── 8. a protected asset OPENS read-only (spec §6.2) ─────────────────────────────────────
    await openAsset(main, 'skill', LOCKED)
    await waitFor('the locked skill tab', async () => {
      const l = await tabLabels(editor)
      return l.some((x) => x.includes(LOCKED))
    })
    await waitFor('the locked tab on screen', async () => {
      const d = await visibleDoc(editor)
      return d !== null && /Locked\. Opens read-only\./.test(d)
    })
    const lockedStatus = (await visibleStatus(editor)) ?? ''
    check(
      'a hivemind skill opens read-only, with the notice',
      /is read-only/.test(lockedStatus),
      lockedStatus
    )
    const saveDisabled = await editor.evalJs(`(() => {
      const p = ${VISIBLE_PANEL}
      const b = Array.from(p.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Save')
      return b ? b.disabled : null
    })()`)
    check('Save is disabled on a read-only tab', saveDisabled === true, saveDisabled)
    const badge = await editor.evalJs(`(() => {
      const p = ${VISIBLE_PANEL}
      const b = p.querySelector('[data-testid="tier-badge"]')
      return b ? b.textContent : null
    })()`)
    check('the status bar carries the tier badge', badge !== null, badge)
    check(
      'the read-only surface is contenteditable=false',
      (await visibleEditable(editor)) === 'false'
    )

    // The other branch of `isAssetEditable`: references are locked by frontmatter tier, not by
    // directory, and share none of the skill path's code.
    await openAsset(main, 'reference', LOCKED_REF)
    await waitFor('the locked reference tab on screen', async () => {
      const d = await visibleDoc(editor)
      return d !== null && /locked reference/i.test(d)
    })
    const refStatus = (await visibleStatus(editor)) ?? ''
    check(
      'a hivemind reference opens read-only too',
      /is read-only/.test(refStatus) && (await visibleEditable(editor)) === 'false',
      refStatus
    )

    // ── 9. Edit a copy (spec §6.2) ───────────────────────────────────────────────────────────
    check('switching back to the locked skill', await clickTab(editor, `skill · ${LOCKED} `))
    await waitFor('the locked skill on screen again', async () => {
      const d = await visibleDoc(editor)
      return d !== null && /Locked\. Opens read-only\./.test(d)
    })
    const tabsBeforeFork = (await tabLabels(editor)).length
    check('Edit a copy is offered', await clickInPane(editor, /^edit a copy$/i))
    await waitFor('the fork dialog', () =>
      editor.evalJs(`!!document.querySelector('input[aria-label="New skill name"]')`)
    )
    // Type a DIFFERENT name than the default (which is the source name, fork-in-place): the tab
    // relabelling assertion below is vacuous otherwise.
    await editor.evalJs(`(() => {
      const i = document.querySelector('input[aria-label="New skill name"]')
      i.focus()
      i.setSelectionRange(0, i.value.length)
      return true
    })()`)
    await editor.insertText(LOCKED_COPY)
    await waitFor('the new name in the dialog', () =>
      editor.evalJs(
        `document.querySelector('input[aria-label="New skill name"]').value === ${JSON.stringify(LOCKED_COPY)}`
      )
    )
    await editor.evalJs(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => /^copy$/i.test(x.textContent.trim()))
      b.click()
      return true
    })()`)
    const forkedLabels = await waitFor('the tab to be relabelled to the copy', async () => {
      const l = await tabLabels(editor)
      return l.some((x) => x.includes(LOCKED_COPY)) ? l : false
    })
    check('Edit a copy does not change the tab count', forkedLabels.length === tabsBeforeFork, {
      before: tabsBeforeFork,
      after: forkedLabels.length
    })
    check(
      'the tab carries the new name',
      forkedLabels.some((x) => x.includes(LOCKED_COPY))
    )
    check('the copy exists on disk', fs.existsSync(skillFile(userSkill(LOCKED_COPY))))
    await waitFor('the copy to render', async () => {
      const d = await visibleDoc(editor)
      return d !== null && /Locked\. Opens read-only\./.test(d)
    })
    const copyStatus = (await visibleStatus(editor)) ?? ''
    check('the read-only notice is gone on the copy', !/is read-only/.test(copyStatus), copyStatus)
    check('the copy is editable again', (await visibleEditable(editor)) === 'true')

    // ── 10. arm the restart (spec §8.3 step 5, widened to the whole tab SET) ─────────────────
    // Two tabs typed into, then the app killed — the drafts AND the open tab set AND each tab's
    // cursor have to come back. `restore` is a second phase because the assertion between them
    // is a process death.
    check('switching to tab A to arm it', await clickTab(editor, ALPHA))
    await focusVisibleEnd(editor)
    await editor.insertText(`\n${ARM_A}\n`)
    await waitFor('tab A armed', async () => (await visibleDoc(editor)).includes(ARM_A))
    const cursorA = await visibleCursor(editor)
    check('switching to tab B to arm it', await clickTab(editor, BETA))
    await focusVisibleEnd(editor)
    await editor.insertText(`\n${ARM_B}\n`)
    await waitFor('tab B armed', async () => (await visibleDoc(editor)).includes(ARM_B))
    const cursorB = await visibleCursor(editor)

    // Main owns both debounces (~500ms for drafts, 1s for the tab set). Read the FILES rather
    // than trusting the UI: that is what makes "it was persisted" a fact.
    //
    // Poll for the cursors just read off the status bar, not merely for the tab NAMES: the tab
    // set has been persisted continuously since the first tab opened, so a name check passes
    // against a snapshot minutes old and the `restore` phase then measures against a cursor that
    // was never the last one. (Main's 1s timer is cleared and re-armed by every cursor move, so
    // during a busy stretch the file legitimately lags — this is what makes the wait necessary
    // rather than optional.)
    const cursorOf = (t) => (t.view ? `${t.view.line}:${t.view.col}` : null)
    const persisted = await waitFor(
      'the tab set to be persisted with the cursors just recorded',
      () => {
        try {
          const doc = JSON.parse(fs.readFileSync(tabsFile, 'utf8'))
          const tabs = doc.tabs?.tabs ?? []
          const a = tabs.find((t) => t.name === ALPHA)
          const b = tabs.find((t) => t.name === BETA)
          return a && b && cursorOf(a) === cursorA && cursorOf(b) === cursorB ? doc.tabs : false
        } catch {
          return false
        }
      },
      20000
    ).catch(() => null)
    check(
      'the tab set is persisted with the cursor each tab was left on',
      persisted !== null,
      persisted?.tabs.map((t) => `${t.name}@${cursorOf(t)}`)
    )

    const readDrafts = () => {
      try {
        return fs
          .readdirSync(path.join(HOME, 'drafts'))
          .filter((n) => n.endsWith('.json'))
          .map((n) => JSON.parse(fs.readFileSync(path.join(HOME, 'drafts', n), 'utf8')))
      } catch {
        return []
      }
    }
    const drafts = await waitFor(
      'both armed drafts to reach disk',
      () => {
        const d = readDrafts()
        return d.some((x) => x.content.includes(ARM_A)) && d.some((x) => x.content.includes(ARM_B))
          ? d
          : false
      },
      20000
    ).catch(() => readDrafts())
    check(
      'both armed drafts are on disk before the quit',
      drafts.some((d) => d.content.includes(ARM_A)) &&
        drafts.some((d) => d.content.includes(ARM_B)),
      drafts.map((d) => d.name)
    )

    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        {
          cursorA,
          cursorB,
          persisted: persisted ?? JSON.parse(fs.readFileSync(tabsFile, 'utf8')).tabs
        },
        null,
        2
      ),
      'utf8'
    )
    console.error(`\ntab A cursor ${cursorA}, tab B cursor ${cursorB} — quitting the app`)
    // Closing the main window takes the editor with it (spec §3.4) and flushes both debounces.
    await main.evalJs(`window.close()`)
    await sleep(4000)
    console.error('now relaunch against the same ARGUS_HOME and run: restore')
  } finally {
    // Restore what THIS SCRIPT wrote. The saves above went through the app's own Save and are
    // legitimate product writes — re-run the `seed` phase to reset those.
    if (movedAlpha && fs.existsSync(hiveSkill(ALPHA))) {
      fs.rmSync(userSkill(ALPHA), { recursive: true, force: true })
      fs.renameSync(hiveSkill(ALPHA), userSkill(ALPHA))
    }
  }
  report()
}

// ── restore ───────────────────────────────────────────────────────────────────────────────────

if (PHASE === 'restore') {
  const armed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const main = await connectMain()
  await gotoLibrary(main)
  await main.evalJs(`document.querySelector('[aria-label="Edit \\u00b7 ${ALPHA}"]').click()`)
  const editor = await openEditorWindow()

  const expected = armed.persisted.tabs.map((t) => t.name)
  const labels = await waitFor('the restored tab strip', async () => {
    const l = await tabLabels(editor)
    return l.length >= expected.length ? l : false
  })
  check(
    'the whole tab set comes back after a restart',
    expected.every((n) => labels.some((l) => l.includes(n))),
    { expected, labels }
  )

  for (const [name, marker, cursor] of [
    [ALPHA, ARM_A, armed.cursorA],
    [BETA, ARM_B, armed.cursorB]
  ]) {
    check(`switching to the restored ${name}`, await clickTab(editor, name))
    const doc = await waitFor(`the restored draft in ${name}`, async () => {
      const d = await visibleDoc(editor)
      return d && d.includes(marker) ? d : false
    }).catch(() => null)
    check(`${name} came back with its draft`, doc !== null)
    const landed = await waitFor(
      `the restored cursor in ${name}`,
      async () => {
        const c = await visibleCursor(editor)
        return c === cursor ? c : false
      },
      8000
    ).catch(async () => visibleCursor(editor))
    // §8.3 step 5 could only ever check the draft; the cursor is what this increment added.
    check(`${name} came back on the line it was left on`, landed === cursor, {
      expected: cursor,
      actual: landed
    })
  }

  // Leave the drafts discarded so a repeat `main` run does not open onto a restore banner.
  for (const name of [ALPHA, BETA]) {
    await editor
      .evalJs(`window.argus.editor.discardDraft({ kind: 'skill', name: ${JSON.stringify(name)} })`)
      .catch(() => {})
  }
  fs.rmSync(stateFile, { force: true })

  editor.close()
  main.close()
  report()
}
