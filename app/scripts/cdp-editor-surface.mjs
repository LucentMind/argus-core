#!/usr/bin/env node
/**
 * The editing-surface runtime gate (spec §8.3 steps 3, 4 and 6).
 *
 * Everything here is out of vitest's reach on purpose (§8.2): CodeMirror measures real DOM and
 * jsdom has no layout, so undo history, gutter markers and a real focus event can only be
 * observed in a real window.
 *
 *   ARGUS_HOME=/tmp/argus-surface-gate npx electron-vite dev --remoteDebuggingPort 9223
 *   node scripts/cdp-editor-surface.mjs
 *
 * The scratch ARGUS_HOME must hold at least one short user skill, and an assist provider must be
 * configured — step 3 runs a real Improve. What it returns does not matter and is not asserted;
 * the assertion is that undo restores the pre-accept text whatever came back. Budget a minute.
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
  SURFACE,
  docText,
  focusEnd
} from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9223'
const HOME = process.env.ARGUS_HOME
const MARKER = 'CDP-SURFACE-MARKER'

if (!HOME) {
  console.error('ARGUS_HOME must be set to the same scratch home the app was booted with')
  process.exit(1)
}

const listTargets = () => list(PORT)
const click = (conn, re) =>
  conn.evalJs(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => ${re}.test((x.textContent || '').trim()))
    if (!b) return false
    b.click()
    return true
  })()`)

/** Same navigation the drafts gate uses: the settings payload and the skills list both load
 *  async, so poll-and-reclick rather than one click that can land before the nav exists. */
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
        const lib = nav && [...nav.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Library')
        if (lib) lib.click()
        return 1
      })()`)
      return false
    },
    30000
  )
}

const main = await connect((await listTargets())[0])
await gotoLibrary(main)
await main.evalJs(`document.querySelector('[aria-label^="Edit \\u00b7 "]').click()`)
let target = null
await waitFor('the editor window', async () => {
  target = (await listTargets()).find((t) => t.url.includes('editor.html'))
  return !!target
})
const editor = await connect(target)
await waitFor('the CodeMirror surface to render', () =>
  editor.evalJs(`!!document.querySelector(${JSON.stringify(SURFACE)})`)
)
check('the editing surface is CodeMirror, not a textarea', true)

const skillName = await editor.evalJs(
  `document.querySelector(${JSON.stringify(SURFACE)}).getAttribute('aria-label').replace(/^skill\\s*\\u00b7\\s*/, '')`
)

// ── §8.3 step 3 — the single most important assertion in the suite (defect §1.1.1) ────────────
// Increment 2's editor called setBuffer on a controlled textarea to accept an assist draft,
// which destroys the browser's native undo stack: there was no Ctrl+Z back to what you wrote,
// and no copy of it anywhere. This proves the transaction-based accept is undoable.
await focusEnd(editor)
await editor.insertText(`\n${MARKER}\n`)
const beforeAccept = await waitFor('the marker to reach the document', async () => {
  const t = await docText(editor)
  return t.includes(MARKER) ? t : false
})
check('typing reaches the CodeMirror document', beforeAccept.includes(MARKER))

check('Improve is offered', await click(editor, /^improve$/i))
await waitFor(
  'the assist proposal (a real model round trip)',
  () =>
    editor.evalJs(
      `!!document.querySelector('[role="group"][aria-label="Current compared with Proposed"]')`
    ),
  120000
)
check('Accept is offered on the proposal', await click(editor, /^accept$/i))
await waitFor('the proposal to be applied', async () => {
  const t = await docText(editor)
  return t !== beforeAccept ? t : false
})

await editor.evalJs(`document.querySelector(${JSON.stringify(SURFACE)}).focus()`)
await editor.key('z', { modifiers: 2, code: 'KeyZ', keyCode: 90 })
const afterUndo = await waitFor(
  'the document after undo',
  async () => {
    const t = await docText(editor)
    return t.includes(MARKER) ? t : false
  },
  10000
).catch(() => null)
check(
  'Ctrl+Z after accepting an assist draft returns the pre-accept text (defect §1.1.1)',
  afterUndo !== null && afterUndo.includes(MARKER),
  afterUndo === null ? 'the marker never came back' : afterUndo.slice(-80)
)

// ── §8.3 step 4 — a validation error is locatable (defect §1.1.2) ─────────────────────────────
// Select the whole document and replace it with a skill whose frontmatter `name:` disagrees with
// the folder — an error `validateSkill` reports with a line, on line 2 of what is inserted.
await editor.evalJs(`(() => {
  const el = document.querySelector(${JSON.stringify(SURFACE)})
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  return true
})()`)
await editor.insertText('---\nname: definitely-not-the-folder\ndescription: d\n---\n\nbody\n')

const markerOnGutter = await waitFor('a lint marker in the gutter', () =>
  editor.evalJs(`!!document.querySelector('.cm-lint-marker-error')`)
)
check('a validation error puts a marker in the gutter', markerOnGutter)

const problemsOpened = await waitFor('the problems summary', () => click(editor, /error/i))
check('the problems strip reports the error', problemsOpened)
const jumped = await waitFor('a clickable problems row', () =>
  editor.evalJs(`(() => {
    const row = Array.from(document.querySelectorAll('li button')).find((b) => /must match the skill folder/i.test(b.textContent || ''))
    if (!row) return false
    row.click()
    return true
  })()`)
)
check('the problems row is clickable', jumped)
// The status bar is the observable for "the cursor actually moved there" — `name:` is line 2.
const position = await waitFor('the status bar to show the jumped-to position', async () => {
  const t = await editor.evalJs(
    `Array.from(document.querySelectorAll('span')).map(s => s.textContent).find(t => /^\\d+:\\d+$/.test(t || ''))`
  )
  return t || false
})
check('clicking the problems row jumps to the offending line', position.startsWith('2:'), position)

// ── §8.3 step 6 — external change noticed on focus, and Compare renders ───────────────────────
// The drafts gate reaches the conflict banner through a rejected Save. This is the *other*
// trigger from spec §4.4 — the focus-time re-read — and it is the one no in-process test can
// reach, because it needs a real window-focus event after a second, independent writer.
const skillFile = path.join(HOME, 'skills-user', skillName, 'SKILL.md')
const original = fs.readFileSync(skillFile, 'utf8')
fs.writeFileSync(skillFile, `${original}\n<!-- changed on disk by the surface gate -->\n`, 'utf8')

await main.send('Page.bringToFront')
await sleep(500)
await editor.send('Page.bringToFront')

const banner = await waitFor('the staleness banner after refocus', async () => {
  const text = await editor.evalJs(
    `Array.from(document.querySelectorAll('[role="status"]')).map((n) => n.textContent).join(' | ')`
  )
  return /changed on disk since your draft|saved version is newer/i.test(text) ? text : false
})
check('an external edit noticed on focus raises the staleness banner', true, banner)

check('Compare is offered', await click(editor, /^compare$/i))
const diff = await waitFor('the diff view', () =>
  editor.evalJs(
    `!!document.querySelector('[role="group"][aria-label="On disk compared with Yours"]')`
  )
)
check('Compare renders a diff', diff)

const surfaceStillMounted = await editor.evalJs(
  `!!document.querySelector(${JSON.stringify(SURFACE)})`
)
check(
  'the surface stays mounted while comparing (undo history and cursor survive)',
  surfaceStillMounted
)

// Cleanup, so a re-run starts from the same footing.
fs.writeFileSync(skillFile, original, 'utf8')
await editor.evalJs(
  `window.argus.editor.discardDraft({ kind: 'skill', name: ${JSON.stringify(skillName)} })`
)
editor.close()
main.close()
report()
