#!/usr/bin/env node
/**
 * The commands/quick-open/links/find-references runtime gate (spec §6.2, §6.3, §6.4).
 *
 * Everything this increment added that matters is out of vitest's reach (§8.2), and this
 * increment widens the gap again:
 *
 *   - `CodeSurface` is MOCKED as a `<textarea>` in every renderer test, because CodeMirror
 *     measures real DOM and jsdom has none — so nothing in the unit suite has ever seen a real
 *     CodeMirror, which means link decorations, Ctrl+click hit-testing and `posAtCoords` have
 *     ZERO coverage. `posAtCoords` in particular needs real layout: it maps a screen coordinate
 *     to a document position, and jsdom's DOM has no boxes to hit-test against.
 *   - jsdom applies NO CSS, so the palette overlay, its scroll-into-view and the dock's collapse
 *     are all unverifiable there.
 *   - The window keymap's `defaultPrevented` handshake with CodeMirror's own keymap only exists
 *     when there is a real CodeMirror keymap to hand it back from — assertion 6 below (Ctrl+S in
 *     Preview mode, where the surface is `inert` and focus is on `<body>`) is exactly the path
 *     that only the window-level fallback can reach.
 *
 * NOTE on markdown link decorations and `visibleRanges`: Task 13's reviewer flagged that a link
 * straddling the boundary between two CodeMirror `visibleRanges` would go undecorated on both
 * sides of the split (`extensions/links.ts`'s `build()` scans each visible range independently).
 * That is only reachable with CM folding, which this markdown setup does not configure anywhere
 * — there is no fold gutter, no fold extension in `extensions/setup.ts`. Left as a note, not an
 * assertion, per the brief: constructing it would mean adding fold support this increment never
 * shipped, which is a product change, not a test.
 *
 * ── The fixture ───────────────────────────────────────────────────────────────────────────────
 *
 * Run the `seed` phase first — it writes the whole scratch home and needs no app:
 *
 *   ARGUS_HOME=/tmp/argus-cmd-gate node scripts/cdp-editor-commands.mjs seed
 *
 * It creates TWO user skills (`cmd-alpha`, `cmd-beta`), TWO user references (`cmd-target.md`,
 * with a `title:` frontmatter field, and `cmd-citer.md`, whose body mentions `cmd-target.md` in
 * plain prose AND links to it as `[cmd-target.md](cmd-target.md)`, plus a link to a file that
 * does not exist), and ONE generated reference (`INDEX.md`). `config/settings.json` gets
 * `onboarding.completedAt` so the first-run wizard never covers anything this gate touches.
 *
 * DEVIATION from the brief worth flagging explicitly: the brief describes `cmd-citer.md` as
 * holding the plain-text mention at "line 1" and separately requires every quick-open row to
 * carry a tier badge (assertion 1). Both are true only if `cmd-citer.md` has NO frontmatter
 * (`refTier` returns null without one — CommandPalette renders no badge span at all for a null
 * tier) — but a tier badge is exactly what `refTier` needs frontmatter to report. The two are
 * structurally incompatible for the SAME file: `fmBlock` only recognises frontmatter that starts
 * at byte 0, so tagging `trust_tier: user` necessarily pushes the mention off line 1. This script
 * resolves it by tagging `cmd-citer.md` (and `cmd-target.md`, and `INDEX.md`) with
 * `trust_tier: user` — so assertion 1 is genuinely true for every row — and reads the mention's
 * ACTUAL line number back off the file it just wrote for assertion 11, rather than hard-coding
 * `1`. The assertion is exactly as strong either way: a real, specific, correct line number that
 * a regression would still move or lose. Real reference-sync-generated `INDEX.md` carries no
 * frontmatter at all (`refSync/engine.ts`'s `generateReferencesIndex` emits bare markdown) — this
 * scratch home has no Confluence spaces configured, so nothing ever regenerates it, and tagging
 * the seeded copy is safe: `isGeneratedAsset` keys on the FILENAME, not its content, so the
 * read-only/notice assertions (12) are untouched by this.
 *
 * ── The run ───────────────────────────────────────────────────────────────────────────────────
 *
 * One phase, like `cdp-editor-window.mjs` / `cdp-editor-surface.mjs` (no restart is asserted
 * here, unlike `cdp-editor-tabs.mjs`/`cdp-editor-drafts.mjs`):
 *
 *   cd app
 *   ARGUS_HOME=/tmp/argus-cmd-gate npx electron-vite dev --remoteDebuggingPort 9224
 *   ARGUS_HOME=/tmp/argus-cmd-gate CDP_PORT=9224 node scripts/cdp-editor-commands.mjs
 *
 * Port 9224 is deliberately NOT 9223 (the other gates' default): a stray dev instance from
 * another session answering on 9223 would silently be driven instead of this fixture, and
 * `connectMain` below only refuses that by asking the target for a skill only THIS seed wrote.
 *
 * The assertions below run in a different ORDER than the brief lists them, grouped to minimise
 * tab churn (e.g. both `INDEX.md` assertions run back to back, then its tab is closed with
 * Ctrl+W so that assertion doubles as "closes the active tab"). Every `check()` name below says
 * which numbered assertion it covers.
 *
 * The script itself performs no direct filesystem writes to the fixture — every on-disk change
 * (Ctrl+S saves, the draft file) is the app's own, legitimate write, exactly like the other
 * gates. Re-run `seed` before re-running `main` to reset those.
 *
 * Env: CDP_PORT (default 9224), ARGUS_HOME (required).
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

const PORT = process.env.CDP_PORT || '9224'
const HOME = process.env.ARGUS_HOME
const PHASE = process.argv[2] ?? 'main'

const ALPHA = 'cmd-alpha'
const BETA = 'cmd-beta'
const TARGET = 'cmd-target.md'
const CITER = 'cmd-citer.md'
const INDEX = 'INDEX.md'
const DRAFT_NAME = 'cmd-draft-thing'

const MARKER_BETA = 'CDP-CMD-MARKER-BETA'
const MARKER_ALPHA = 'CDP-CMD-MARKER-ALPHA'
const MARKER_DRAFT = 'CDP-CMD-MARKER-DRAFT'
const CITER_MENTION_LINE_TEXT = 'see cmd-target.md for the mapping'

if (!HOME) {
  console.error('ARGUS_HOME must be set to the same scratch home the app was booted with')
  process.exit(1)
}
if (PHASE !== 'seed' && PHASE !== 'main') {
  console.error('usage: cdp-editor-commands.mjs seed|main')
  process.exit(1)
}

const listTargets = () => list(PORT)
const userSkill = (name) => path.join(HOME, 'skills-user', name)
const skillFile = (name) => path.join(userSkill(name), 'SKILL.md')
const refFile = (name) => path.join(HOME, 'references', name)
const draftsDir = path.join(HOME, 'drafts')

// ── seed ──────────────────────────────────────────────────────────────────────────────────────

if (PHASE === 'seed') {
  const skill = (name, bodyLines) =>
    `---\nname: ${name}\ndescription: Fixture skill for the commands runtime gate (${name}).\n---\n\n# ${name}\n\n` +
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

  fs.mkdirSync(userSkill(ALPHA), { recursive: true })
  fs.writeFileSync(skillFile(ALPHA), skill(ALPHA, ['Alpha fixture body, line one.']))
  fs.mkdirSync(userSkill(BETA), { recursive: true })
  fs.writeFileSync(skillFile(BETA), skill(BETA, ['Beta fixture body, line one.']))

  fs.mkdirSync(path.join(HOME, 'references'), { recursive: true })
  fs.writeFileSync(
    refFile(TARGET),
    '---\ntitle: Command target\ntrust_tier: user\n---\n\n' +
      '# Command target\n\nFixture reference for the runtime commands gate.\n'
  )
  // Line 1 of the FRONTMATTER-STRIPPED body is the plain-text mention `findReferences` scans
  // for; line 2 (blank) then a real markdown link to the same file (for the Ctrl+click
  // assertions), then a link to a file that does not exist (for the broken-link assertion). See
  // the file-level comment above for why this carries frontmatter at all, and why the mention's
  // line number is read back from disk in the `main` phase rather than assumed.
  fs.writeFileSync(
    refFile(CITER),
    '---\ntrust_tier: user\n---\n\n' +
      `${CITER_MENTION_LINE_TEXT}\n\n` +
      `[${TARGET}](${TARGET})\n\n` +
      '[missing](does-not-exist.md)\n'
  )
  // Real reference-sync output carries no frontmatter (`generateReferencesIndex`,
  // refSync/engine.ts) — this scratch home has no Confluence spaces configured, so nothing ever
  // regenerates this file, and tagging it is safe (`isGeneratedAsset` keys on the filename only).
  // See the file-level comment for why it is tagged at all.
  fs.writeFileSync(
    refFile(INDEX),
    '---\ntrust_tier: user\n---\n\n' +
      '# References index\n<!-- generated by reference-sync — do not edit -->\n\n' +
      `- [Command target](${TARGET}) — Fixture reference for the runtime commands gate.\n`
  )

  console.error(
    `seeded ${HOME}\n\nnow boot:\n  cd app && ARGUS_HOME=${HOME} npx electron-vite dev --remoteDebuggingPort ${PORT}`
  )
  process.exit(0)
}

// ── shared plumbing ───────────────────────────────────────────────────────────────────────────

/** Connect to the main window and prove it is THIS fixture — a busy debug port on another
 *  session's dev instance still answers `/json/list`, with a DIFFERENT window, and nothing in
 *  the response says so. Asking for skills only this fixture has is the cheapest refusal. */
const connectMain = async () => {
  const main = await connect(mainWindow(await listTargets()))
  await waitFor('window.argus in the main window', () =>
    main.evalJs('!!(window.argus && window.argus.editor && window.argus.skills)')
  )
  const names = await main.evalJs(
    `window.argus.skills.list().then((p) => p.skills.map((s) => s.name))`
  )
  if (!Array.isArray(names) || !names.includes(ALPHA) || !names.includes(BETA)) {
    console.error(
      `the app on port ${PORT} is not the fixture this gate seeded (no "${ALPHA}"/"${BETA}" skills).\n` +
        `Its skills: ${JSON.stringify(names)}\nRefusing to drive it. Boot with ARGUS_HOME=${HOME}.`
    )
    process.exit(1)
  }
  return main
}

/** Open (or focus) the editor on an asset through the same IPC the Library's Edit button calls. */
const openAsset = (main, kind, name, mode = 'edit') =>
  main.evalJs(
    `window.argus.editor.open({ kind: ${JSON.stringify(kind)}, name: ${JSON.stringify(name)}, mode: ${JSON.stringify(mode)} }).then(() => true)`
  )

const openEditorWindow = async () => {
  let target = null
  await waitFor('the editor window', async () => {
    target = (await listTargets()).find((t) => t.url.includes('editor.html'))
    return !!target
  })
  const editor = await connect(target)
  await waitFor('the CodeMirror surface to render', async () => (await surfaceCount(editor)) > 0)
  // `viewMode` is persisted; a run that ended in Preview makes the next boot open in Preview.
  await toEditorMode(editor)
  return editor
}

const surfaceCount = (conn) => conn.evalJs(`document.querySelectorAll('.cm-content').length`)
/** The asset tab strip's OWN tabs — not `BottomDock`'s Problems/References tablist, which also
 *  uses `role="tab"`. `TabBar`'s `<div role="tablist">` carries no `aria-label`; the dock's does
 *  (`aria-label="Editor panels"`), which is what distinguishes the two. Discovered the hard way:
 *  an unscoped query inflates the count whenever the dock is open (e.g. INDEX.md's read-only
 *  notice doesn't open it, but any tab with validation issues does), so a Ctrl+W that closes one
 *  asset tab can also take the dock away with it, moving the count by 2 instead of 1. */
const tabLabels = (conn) =>
  conn.evalJs(
    `Array.from(document.querySelectorAll('[role="tablist"]:not([aria-label]) [role="tab"]')).map((t) => t.getAttribute('aria-label'))`
  )
const visibleDoc = (conn) =>
  conn.evalJs(`(() => { const e = ${VISIBLE_SURFACE}; return e ? e.innerText : null })()`)
const visibleEditable = (conn) =>
  conn.evalJs(
    `(() => { const e = ${VISIBLE_SURFACE}; return e ? e.getAttribute('contenteditable') : null })()`
  )
const visibleStatus = (conn) =>
  conn.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    if (!p) return null
    return Array.from(p.querySelectorAll('[role="status"]')).map((n) => n.textContent).join(' | ')
  })()`)
const activeTabName = (conn) =>
  conn.evalJs(`(() => {
    const e = ${VISIBLE_SURFACE}
    if (!e) return null
    const m = (e.getAttribute('aria-label') || '').match(/^(?:skill|reference)\\s*\\u00b7\\s*(.+)$/)
    return m ? m[1] : null
  })()`)
const hasWrapClass = (conn) =>
  conn.evalJs(
    `(() => { const e = ${VISIBLE_SURFACE}; return e ? e.classList.contains('cm-lineWrapping') : null })()`
  )

/** Focus the visible surface end (see cdp.mjs's `focusVisibleEnd`) then type. */
const typeIntoVisible = async (conn, text) => {
  await focusVisibleEnd(conn)
  await conn.insertText(text)
}

// ── the window's chords, matching lib/commands.ts's registry (spec §6.4) ───────────────────────
// CDP modifiers bitfield: 1 alt, 2 ctrl, 4 meta, 8 shift (see cdp.mjs's `key` doc comment).
const chord = (conn, keyName, modifiers, code, keyCode) =>
  conn.key(keyName, { modifiers, code, keyCode })
const ctrlP = (c) => chord(c, 'p', 2, 'KeyP', 80)
const ctrlShiftP = (c) => chord(c, 'p', 2 | 8, 'KeyP', 80)
const ctrlShiftV = (c) => chord(c, 'v', 2 | 8, 'KeyV', 86)
const ctrlShiftF = (c) => chord(c, 'f', 2 | 8, 'KeyF', 70)
const ctrlW = (c) => chord(c, 'w', 2, 'KeyW', 87)
const ctrlTab = (c) => chord(c, 'Tab', 2, 'Tab', 9)
const ctrlS = (c) => chord(c, 's', 2, 'KeyS', 83)
const enterKey = (c) => chord(c, 'Enter', 0, 'Enter', 13)

/** Open the palette with Ctrl+P (assets) or Ctrl+Shift+P (commands, pre-filled with `>`), and
 *  wait for the overlay to actually mount before typing into it — React renders it a tick after
 *  the keydown, and `autoFocus` only claims focus once it does. */
const openPalette = async (conn, which) => {
  if (which === 'assets') await ctrlP(conn)
  else await ctrlShiftP(conn)
  const wantLabel = which === 'assets' ? 'Open asset' : 'Commands'
  await waitFor(`the palette (${wantLabel})`, () =>
    conn.evalJs(
      `document.querySelector('[role="dialog"]')?.getAttribute('aria-label') === ${JSON.stringify(wantLabel)}`
    )
  )
  await conn.evalJs(`document.querySelector('input[role="combobox"]')?.focus()`)
}

const paletteInputValue = (conn) =>
  conn.evalJs(`document.querySelector('input[role="combobox"]')?.value ?? null`)

/** Asset-mode rows: name (from the `font-mono` name span) and tier badge text (the
 *  `rounded-r1` SPAN — the Discard button shares those utility classes but is a `<button>`, so
 *  the tag in the selector is what tells the two apart). */
const paletteAssetRows = (conn) =>
  conn.evalJs(`Array.from(document.querySelectorAll('#palette-list [role="option"]')).map((li) => ({
    name: li.querySelector('span.font-mono')?.textContent ?? null,
    badge: li.querySelector('span.rounded-r1')?.textContent ?? null
  }))`)

/** Command-mode rows: title and disabled state. */
const paletteCommandRows = (conn) =>
  conn.evalJs(`Array.from(document.querySelectorAll('#palette-list [role="option"]')).map((li) => ({
    title: li.querySelector('span.truncate')?.textContent ?? null,
    disabled: li.getAttribute('aria-disabled') === 'true'
  }))`)

/** Click a command row by its exact title — deterministic regardless of fuzzy-match ranking
 *  (`Save` and `Save all` both match a query of `save`). */
const clickCommandRow = (conn, title) =>
  conn.evalJs(`(() => {
    const li = Array.from(document.querySelectorAll('#palette-list [role="option"]'))
      .find((el) => (el.querySelector('span.truncate')?.textContent ?? '').trim() === ${JSON.stringify(title)})
    if (!li) return false
    li.click()
    return true
  })()`)

/** Dispatch the backdrop's `onMouseDown` (its `onClose`) directly. `.click()` only fires a
 *  synthetic `click` event, not `mousedown` — the handler this overlay actually listens for. */
const closePalette = (conn) =>
  conn.evalJs(`(() => {
    const el = document.querySelector('[data-testid="palette-backdrop"]')
    if (!el) return false
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return true
  })()`)

/** A REAL synthesized mouse event at coordinates, through the CDP Input domain — not a `.click()`
 *  on the decoration span. The link handler (`extensions/links.ts`) reads `e.clientX/clientY` and
 *  calls `view.posAtCoords`, which needs real layout to resolve; a scripted `.click()` on the
 *  decoration element never supplies coordinates at all, so it would exercise a different (and
 *  much less interesting) code path than a real click does. */
const ctrlClickAt = async (conn, x, y) => {
  const base = { x, y, button: 'left', clickCount: 1, modifiers: 2 }
  await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

/** Center of the decorated span with class `cls`, inside the VISIBLE pane. `null` if absent. */
const linkCenter = (conn, cls) =>
  conn.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    const el = p && p.querySelector('.${cls}')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)

const referenceHits = (conn) =>
  conn.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    if (!p) return []
    return Array.from(p.querySelectorAll('ul li button')).map((b) => b.querySelector('span')?.textContent ?? '')
  })()`)

const clickReferenceHit = (conn, label) =>
  conn.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    const b = p && Array.from(p.querySelectorAll('ul li button')).find((x) => (x.querySelector('span')?.textContent ?? '') === ${JSON.stringify(label)})
    if (!b) return false
    b.click()
    return true
  })()`)

// ── main ──────────────────────────────────────────────────────────────────────────────────────

if (PHASE === 'main') {
  // Read the mention's real line number off the exact bytes this run's `seed` phase wrote —
  // see the file-level comment on why this is not hard-coded to `1`.
  const citerLines = fs.readFileSync(refFile(CITER), 'utf8').split('\n')
  const mentionLine = citerLines.findIndex((l) => l === CITER_MENTION_LINE_TEXT) + 1
  if (mentionLine < 1) {
    console.error(`could not find the mention line in ${refFile(CITER)} — did seed run?`)
    process.exit(1)
  }

  const main = await connectMain()
  check(
    'cmd-alpha opens via the same IPC the Library Edit button uses',
    await openAsset(main, 'skill', ALPHA)
  )
  const editor = await openEditorWindow()

  // ── 1 & 2. Ctrl+P quick open: lists the fixture, badges, narrows, Enter opens ───────────────
  await openPalette(editor, 'assets')
  const expectedNames = [ALPHA, BETA, TARGET, CITER, INDEX]
  const initialRows = await waitFor('all five fixture rows in quick open', async () => {
    const rows = await paletteAssetRows(editor)
    const names = rows.map((r) => r.name)
    return expectedNames.every((n) => names.includes(n)) ? rows : false
  })
  for (const name of expectedNames) {
    const row = initialRows.find((r) => r.name === name)
    check(`assertion 1: quick-open row "${name}" carries a tier badge`, !!row?.badge, row)
  }

  // The full name, not a short fragment: this scratch home's corpus also carries the app's own
  // bundled core skills (`code-graph`, `code-review`, `contribute-back`, `systematic-triage` —
  // `seedSharedAssets` copies them into every ARGUS_HOME unconditionally, spec-independent of
  // this fixture), and their real, long frontmatter `description` prose is exactly the kind of
  // text a short fuzzy query collides with — verified empirically against the live corpus:
  // `targ`, `beta`, `citer` and `index` all also fuzzy-match one or more of those descriptions
  // (`index` matched `code-graph` too and was the one that actually broke a live run of this
  // gate before this comment existed). `cmd-target.md` does not collide with anything in the
  // real corpus — confirmed both by simulating `fuzzyMatch` offline and by this gate passing.
  await editor.insertText(TARGET)
  const narrowed = await waitFor('quick open narrowed to cmd-target.md', async () => {
    const rows = await paletteAssetRows(editor)
    return rows.length === 1 && rows[0].name === TARGET ? rows : false
  })
  check(
    'assertion 2: typing "cmd-target.md" narrows quick open to cmd-target.md alone',
    narrowed.length === 1
  )
  await enterKey(editor)
  await waitFor(
    'cmd-target.md tab to open and activate',
    async () => (await activeTabName(editor)) === TARGET
  )
  check('assertion 2: Enter opens cmd-target.md in a tab', true)

  // ── 3. Ctrl+Shift+P holding `>`; "wrap" finds Toggle soft wrap; Enter flips wrapping ─────────
  await openPalette(editor, 'commands')
  check(
    'assertion 3: Ctrl+Shift+P pre-fills the query with ">"',
    (await paletteInputValue(editor)) === '>'
  )
  await editor.insertText('wrap')
  const wrapRows = await waitFor('"wrap" narrows to Toggle soft wrap', async () => {
    const rows = await paletteCommandRows(editor)
    return rows.some((r) => r.title === 'Toggle soft wrap') ? rows : false
  })
  check(
    'assertion 3: "wrap" finds "Toggle soft wrap"',
    wrapRows.some((r) => r.title === 'Toggle soft wrap')
  )
  const wrapBefore = await hasWrapClass(editor)
  await clickCommandRow(editor, 'Toggle soft wrap')
  await waitFor('the wrap class to flip', async () => (await hasWrapClass(editor)) !== wrapBefore)
  check(
    'assertion 3: running Toggle soft wrap actually flips .cm-lineWrapping on .cm-content',
    (await hasWrapClass(editor)) === !wrapBefore,
    { before: wrapBefore, after: await hasWrapClass(editor) }
  )

  // ── INDEX.md: assertions 12, then 4, then 7 (Ctrl+W) ────────────────────────────────────────
  // The full name, not `index` — this app also ships a `code-graph` core skill whose long
  // description contains that as a subsequence too (empirically verified live: `index` matched
  // BOTH rows). `INDEX.md` does not collide with anything in the corpus.
  await openPalette(editor, 'assets')
  await editor.insertText(INDEX)
  await waitFor('quick open narrowed to INDEX.md', async () => {
    const rows = await paletteAssetRows(editor)
    return rows.length === 1 && rows[0].name === INDEX
  })
  await enterKey(editor)
  await waitFor(
    'INDEX.md tab to open and activate',
    async () => (await activeTabName(editor)) === INDEX
  )

  const indexStatus = await waitFor('the generated-asset notice', async () => {
    const s = await visibleStatus(editor)
    return s && /generated by reference sync/.test(s) ? s : false
  })
  check(
    'assertion 12: INDEX.md opens with the "generated by reference sync" notice',
    true,
    indexStatus
  )
  const hasEditCopy = await editor.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    return !!(p && Array.from(p.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Edit a copy'))
  })()`)
  check('assertion 12: INDEX.md has no "Edit a copy" button', !hasEditCopy)
  check(
    "assertion 12: INDEX.md's surface is contenteditable=false",
    (await visibleEditable(editor)) === 'false'
  )

  const indexBefore = fs.readFileSync(refFile(INDEX), 'utf8')
  await openPalette(editor, 'commands')
  await editor.insertText('save')
  const saveRow = await waitFor('the Save command row', async () => {
    const rows = await paletteCommandRows(editor)
    return rows.find((r) => r.title === 'Save') ?? false
  })
  check(
    'assertion 4: the Save command renders disabled on a read-only tab',
    saveRow.disabled === true,
    saveRow
  )
  await clickCommandRow(editor, 'Save')
  await sleep(500)
  check(
    'assertion 4: picking a disabled command does not close the palette',
    (await editor.evalJs(
      `document.querySelector('[role="dialog"]')?.getAttribute('aria-label') ?? null`
    )) === 'Commands'
  )
  check(
    'assertion 4: picking a disabled Save does not write INDEX.md',
    fs.readFileSync(refFile(INDEX), 'utf8') === indexBefore
  )
  await closePalette(editor)
  await waitFor('the palette to close', () =>
    editor.evalJs(`!document.querySelector('[role="dialog"]')`)
  )

  const tabCountBeforeClose = (await tabLabels(editor)).length
  await ctrlW(editor)
  await waitFor(
    'INDEX.md tab to close',
    async () => (await tabLabels(editor)).length === tabCountBeforeClose - 1
  )
  check('assertion 7: Ctrl+W closes the active (INDEX.md) tab', true)
  const stillOpen = (await listTargets()).some((t) => t.url.includes('editor.html'))
  check('assertion 7: Ctrl+W does not close the editor window', stillOpen)

  // ── 5. Ctrl+S saves the ACTIVE tab, not the first-opened one ────────────────────────────────
  // Opened via the same IPC as cmd-alpha, not through quick open: this step is not testing
  // search narrowing (that is assertion 2's job, above), and a short fuzzy query is not needed —
  // see the note on `cmd-target.md`'s query for why a short one would be risky here anyway.
  const alphaBefore = fs.readFileSync(skillFile(ALPHA), 'utf8')
  const targetBefore = fs.readFileSync(refFile(TARGET), 'utf8')
  check('cmd-beta opens via the editor:open IPC', await openAsset(main, 'skill', BETA))
  await waitFor(
    'cmd-beta tab to open and activate',
    async () => (await activeTabName(editor)) === BETA
  )
  await typeIntoVisible(editor, `\n${MARKER_BETA}\n`)
  await waitFor('the marker to land in cmd-beta', async () =>
    (await visibleDoc(editor)).includes(MARKER_BETA)
  )
  await ctrlS(editor)
  const betaSaved = await waitFor(
    'cmd-beta to reach disk with the marker',
    () => fs.readFileSync(skillFile(BETA), 'utf8').includes(MARKER_BETA),
    10000
  ).catch(() => false)
  check('assertion 5: Ctrl+S saves the ACTIVE tab (cmd-beta)', betaSaved === true)
  check(
    'assertion 5: Ctrl+S did not touch cmd-alpha (opened first, not active)',
    fs.readFileSync(skillFile(ALPHA), 'utf8') === alphaBefore
  )
  check(
    'assertion 5: Ctrl+S did not touch cmd-target.md (open, not active)',
    fs.readFileSync(refFile(TARGET), 'utf8') === targetBefore
  )

  // ── 6. Ctrl+S works in Preview mode, where the editor subtree is inert and focus is on body ─
  check('switching to cmd-alpha before arming Preview', await clickTab(editor, ALPHA))
  await waitFor(
    'cmd-alpha to be the active tab',
    async () => (await activeTabName(editor)) === ALPHA
  )
  await typeIntoVisible(editor, `\n${MARKER_ALPHA}\n`)
  await waitFor('the marker to land in cmd-alpha', async () =>
    (await visibleDoc(editor)).includes(MARKER_ALPHA)
  )
  // editor -> split -> preview
  await ctrlShiftV(editor)
  await ctrlShiftV(editor)
  const inPreview = await waitFor('focus to leave the (now inert) surface for <body>', () =>
    editor.evalJs(`document.activeElement === document.body`)
  ).catch(() => false)
  check(
    'assertion 6: cycling to Preview makes the editor subtree inert (focus lands on body)',
    inPreview === true
  )
  await ctrlS(editor)
  const alphaSavedFromBody = await waitFor(
    'cmd-alpha to reach disk via the window-level Ctrl+S fallback',
    () => fs.readFileSync(skillFile(ALPHA), 'utf8').includes(MARKER_ALPHA),
    10000
  ).catch(() => false)
  check(
    'assertion 6: Ctrl+S with focus on <body> (Preview mode) still saves the active tab',
    alphaSavedFromBody === true
  )
  // Cycle back to Editor — preview -> editor — both to restore a sane state for what follows and
  // because `viewMode` is persisted to localStorage: leaving it on Preview would make the NEXT
  // tab this script opens (cmd-citer.md, below) mount inert too.
  await toEditorMode(editor)

  // ── 8. Ctrl+Tab cycles and wraps ─────────────────────────────────────────────────────────────
  const beforeCycle = await activeTabName(editor)
  const tabCount = (await tabLabels(editor)).length
  await ctrlTab(editor)
  const afterOne = await waitFor(
    'the active tab to change after one Ctrl+Tab',
    async () => {
      const n = await activeTabName(editor)
      return n !== beforeCycle ? n : false
    },
    10000
  ).catch(() => null)
  check('assertion 8: Ctrl+Tab moves to a different tab', afterOne !== null, {
    beforeCycle,
    afterOne
  })
  for (let i = 1; i < tabCount; i++) await ctrlTab(editor)
  const wrapped = await waitFor(
    'Ctrl+Tab to wrap back to the original tab',
    async () => {
      const n = await activeTabName(editor)
      return n === beforeCycle ? n : false
    },
    10000
  ).catch(() => null)
  check('assertion 8: Ctrl+Tab wraps around after tabCount presses', wrapped === beforeCycle, {
    tabCount,
    wrapped
  })

  // ── 9, 11, 10. open cmd-citer.md; Ctrl+click the good link; find-references; broken link ────
  // Opened via IPC, same reasoning as cmd-beta above — this step tests link decoration and
  // hit-testing, not quick-open search.
  check('cmd-citer.md opens via the editor:open IPC', await openAsset(main, 'reference', CITER))
  await waitFor(
    'cmd-citer.md tab to open and activate',
    async () => (await activeTabName(editor)) === CITER
  )
  await waitFor("cmd-citer.md's content to render", async () => {
    const d = await visibleDoc(editor)
    return d !== null && d.includes(CITER_MENTION_LINE_TEXT)
  })

  const goodLink = await waitFor('the resolved link decoration (.cm-argus-link)', () =>
    linkCenter(editor, 'cm-argus-link')
  )
  await ctrlClickAt(editor, goodLink.x, goodLink.y)
  await waitFor(
    'Ctrl+click on the resolved link to open cmd-target.md',
    async () => (await activeTabName(editor)) === TARGET
  )
  check('assertion 9: Ctrl+click on a resolved markdown link opens cmd-target.md', true)

  // ── 11. Ctrl+Shift+F on cmd-target.md (now active) ──────────────────────────────────────────
  // `activeTabName` flips the instant the NEW surface is visible, which can be a beat before
  // `AssetPane`'s `onCommandState` effect reports the newly-active pane's state up to `EditorApp`
  // and its `commands` memo rebuilds — firing the chord in that gap matched-but-DISABLED (`pane`
  // still momentarily null or the previous tab's), so the keydown was still swallowed
  // (`e.preventDefault()` runs either way) but `findReferences` never ran, and the wait below hung
  // forever. Waiting for the Save button — driven by the same `commandState` — to reflect THIS
  // pane's real (writable) state is a real signal that the window's registry has caught up,
  // not a guessed sleep. Caught empirically: this exact race timed out a live run of this gate.
  await waitFor("cmd-target.md's commandState to settle (Save enabled) before the chord", () =>
    editor.evalJs(`(() => {
      const p = ${VISIBLE_PANEL}
      const b = p && Array.from(p.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Save')
      return !!(b && !b.disabled)
    })()`)
  )
  await ctrlShiftF(editor)
  const hits = await waitFor(
    'find-references results to include cmd-citer.md at the mention line',
    async () => {
      const rows = await referenceHits(editor)
      const want = `${CITER}:${mentionLine}`
      return rows.includes(want) ? rows : false
    },
    15000
  )
  check(
    `assertion 11: Ctrl+Shift+F on cmd-target.md lists cmd-citer.md:${mentionLine} in References`,
    hits.includes(`${CITER}:${mentionLine}`),
    hits
  )
  await clickReferenceHit(editor, `${CITER}:${mentionLine}`)
  await waitFor(
    'clicking the reference hit to open cmd-citer.md',
    async () => (await activeTabName(editor)) === CITER
  )
  check('assertion 11: clicking the cmd-citer.md:N hit opens cmd-citer.md', true)

  // ── 10. the broken link, from the tab we just landed back on ────────────────────────────────
  const brokenLink = await waitFor('the broken link decoration (.cm-argus-link-broken)', () =>
    linkCenter(editor, 'cm-argus-link-broken')
  )
  const tabCountBeforeBrokenClick = (await tabLabels(editor)).length
  await ctrlClickAt(editor, brokenLink.x, brokenLink.y)
  await sleep(700)
  check(
    'assertion 10: Ctrl+click on a broken link opens no tab',
    (await tabLabels(editor)).length === tabCountBeforeBrokenClick
  )
  check(
    'assertion 10: Ctrl+click on a broken link does not navigate away',
    (await activeTabName(editor)) === CITER
  )

  // ── 13. a create-mode draft appears in quick open's Drafts section, and Discard removes it ──
  check(
    'a fresh create-mode tab opens for the draft fixture',
    await openAsset(main, 'skill', DRAFT_NAME, 'create')
  )
  await waitFor(
    'the new create-mode tab to activate',
    async () => (await activeTabName(editor)) === DRAFT_NAME
  )
  await typeIntoVisible(editor, `\n${MARKER_DRAFT}\n`)
  await waitFor(
    'the create-mode draft to reach disk',
    () => {
      try {
        return fs
          .readdirSync(draftsDir)
          .filter((n) => n.endsWith('.json'))
          .some((n) =>
            JSON.parse(fs.readFileSync(path.join(draftsDir, n), 'utf8')).content.includes(
              MARKER_DRAFT
            )
          )
      } catch {
        return false
      }
    },
    10000
  )

  await openPalette(editor, 'assets')
  const draftRow = await waitFor("the draft to appear in quick open's Drafts section", async () => {
    const rows = await paletteAssetRows(editor)
    return rows.find((r) => r.name === DRAFT_NAME) ?? false
  })
  check('assertion 13: the create-mode draft appears in quick open', !!draftRow)
  const hasHeaderAndDiscard = await editor.evalJs(`(() => {
    const rows = Array.from(document.querySelectorAll('#palette-list [role="option"]'))
    const li = rows.find((el) => (el.querySelector('span.font-mono')?.textContent) === ${JSON.stringify(DRAFT_NAME)})
    if (!li) return null
    return {
      hasHeader: !!li.querySelector('span.uppercase'),
      hasDiscard: !!Array.from(li.querySelectorAll('button')).find((b) => /discard/i.test(b.textContent || ''))
    }
  })()`)
  check(
    'assertion 13: the draft row sits under a "Drafts" section header',
    hasHeaderAndDiscard?.hasHeader === true,
    hasHeaderAndDiscard
  )
  check(
    'assertion 13: the draft row carries a Discard button',
    hasHeaderAndDiscard?.hasDiscard === true
  )

  const draftFilesBefore = fs.readdirSync(draftsDir).filter((n) => n.endsWith('.json')).length
  await editor.evalJs(`(() => {
    const rows = Array.from(document.querySelectorAll('#palette-list [role="option"]'))
    const li = rows.find((el) => (el.querySelector('span.font-mono')?.textContent) === ${JSON.stringify(DRAFT_NAME)})
    const b = li && Array.from(li.querySelectorAll('button')).find((x) => /discard/i.test(x.textContent || ''))
    if (b) b.click()
    return !!b
  })()`)
  await waitFor('the draft row to disappear from quick open', async () => {
    const rows = await paletteAssetRows(editor)
    return !rows.some((r) => r.name === DRAFT_NAME)
  })
  check('assertion 13: Discard removes the row from quick open', true)
  await waitFor(
    'the draft file to be gone from disk',
    () =>
      fs.readdirSync(draftsDir).filter((n) => n.endsWith('.json')).length === draftFilesBefore - 1,
    10000
  )
  check('assertion 13: Discard removes the draft file from ARGUS_HOME/drafts', true)

  await closePalette(editor)
  editor.close()
  main.close()
  report()
}
