#!/usr/bin/env node
/**
 * Draft-durability runtime gate (spec §8.3 step 5, §4.2–4.4).
 *
 * Three phases, each its own app boot:
 *
 *   1. ARGUS_HOME=/tmp/argus-draft-gate npx electron-vite dev --remoteDebuggingPort 9223
 *      node scripts/cdp-editor-drafts.mjs arm      # types, checks the flush, quits the app
 *   2. ARGUS_HOME=/tmp/argus-draft-gate npx electron-vite dev --remoteDebuggingPort 9223
 *      node scripts/cdp-editor-drafts.mjs check    # reopens, checks the restore banner
 *   3. ARGUS_HOME=/tmp/argus-draft-gate npx electron-vite dev --remoteDebuggingPort 9223
 *      node scripts/cdp-editor-drafts.mjs compare  # drives the Compare data-loss fix end to end
 *
 * `arm` and `check` are two phases, and not one script that types-then-reopens, because the
 * assertion in between IS a process death — no in-process test can make it. `compare` is a
 * *third* phase rather than a step tacked onto `check`, deliberately: it does not need a restart
 * (nothing about it depends on surviving a quit), and `check`'s own job is already the restore-
 * banner assertion followed by an unconditional Discard — folding Compare in there would mean
 * either racing the two flows in one tab or discarding a still-needed draft mid-scenario. A third
 * phase keeps each phase's setup honest about what it actually needs.
 *
 * `compare` exists because the data-loss bug Finding 1 fixed (Compare used to unmount
 * AssetEditor and silently revert every keystroke on Back) had only ever been exercised in
 * jsdom, where neither Tailwind's `hidden` class nor `display:contents` has any CSS — jsdom
 * loads no stylesheet, so a wrapper with `className="hidden"` is not actually hidden from
 * anything. Only a real, styled window can prove the wrapper really is `display:none` while
 * Compare is up, which is exactly what assertion 4 below reads over CDP with
 * `getComputedStyle`.
 *
 * The scratch ARGUS_HOME must hold at least one user skill. `arm` reads the drafts directory
 * directly, which is what makes "the flush actually landed" a fact rather than an inference
 * from the UI.
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
const PHASE = process.argv[2]
const MARKER = 'CDP-DRAFT-MARKER'

if (!HOME) {
  console.error('ARGUS_HOME must be set to the same scratch home the app was booted with')
  process.exit(1)
}
if (PHASE !== 'arm' && PHASE !== 'check' && PHASE !== 'compare') {
  console.error('usage: cdp-editor-drafts.mjs arm|check|compare')
  process.exit(1)
}

const listTargets = () => list(PORT)

const readDrafts = () => {
  const dir = path.join(HOME, 'drafts')
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
}

/** The Library lives behind the settings gear, same as cdp-editor-window.mjs's gotoLibrary:
 *  the settings payload and skills list both load async, so poll-and-reclick rather than a
 *  single click that can land before the nav exists. Idempotent either way. */
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

/** Open the editor window on the first skill the Library offers, and return both connections. */
const openEditor = async () => {
  const main = await connect((await listTargets())[0])
  await gotoLibrary(main)
  await main.evalJs(`document.querySelector('[aria-label^="Edit \\u00b7 "]').click()`)
  let target = null
  await waitFor('the editor window', async () => {
    target = (await listTargets()).find((t) => t.url.includes('editor.html'))
    return !!target
  })
  const editor = await connect(target)
  await waitFor('the asset to render', () =>
    editor.evalJs(`!!document.querySelector(${JSON.stringify(SURFACE)})`)
  )
  return { main, editor }
}

if (PHASE === 'arm') {
  check('no drafts before typing', readDrafts().length === 0, readDrafts().length)

  const { main, editor } = await openEditor()

  // Type through real Input events — a contenteditable cannot be typed into by assigning a
  // property, and a value assignment reaches CodeMirror's DOM but never its state.
  await focusEnd(editor)
  await editor.insertText(`\n${MARKER}\n`)

  // Persist-before-adopt: the chip is driven by main's draft-saved message, so seeing it is
  // seeing a completed write — not a queued one.
  await waitFor('the Draft chip', () =>
    editor.evalJs(
      `!!Array.from(document.querySelectorAll('span')).find((s) => /^Draft ·/.test(s.textContent))`
    )
  )
  check('status reaches Draft after typing', true)

  const drafted = readDrafts()
  check(
    'the draft is on disk and holds the typed text',
    drafted.some((d) => d.content.includes(MARKER)),
    drafted.map((d) => d.name)
  )

  // §4.3: type again and quit inside the debounce window. This proves the user-facing property
  // spec §4.3 promises: text typed seconds before quit survives it. It also catches a coarse
  // regression — the debounce moving back into the renderer, which window.close() would tear
  // down before it could fire. It does not discriminate flushAll()-before-forceClose() ordering
  // in mainWindow.on('closed'): both calls run synchronously in the same tick, and before-quit
  // calls flushAll() again unconditionally regardless. That ordering is defensive rather than
  // load-bearing — main owns the debounce timer, so nothing here depends on which one runs first.
  await focusEnd(editor)
  await editor.insertText('TAIL')
  await main.evalJs(`window.close()`)
  await sleep(3000)

  const flushed = readDrafts()
  check(
    'the last keystrokes before quit were flushed',
    flushed.some((d) => d.content.includes(`${MARKER}\n`) && d.content.includes('TAIL')),
    flushed.map((d) => d.content.slice(-40))
  )

  editor.close()
  main.close()
  console.error('\nnow relaunch the app against the same ARGUS_HOME and run: check')
  report()
}

if (PHASE === 'check') {
  const armed = readDrafts()
  check('a draft is present before opening', armed.length > 0, armed.length)

  const { main, editor } = await openEditor()

  // openEditor only waits for the surface to exist; the content itself arrives later from an
  // async load() prop, so wait for the marker to actually be in the document before asserting —
  // element-presence and content-settled are different moments, and only the latter is safe
  // to read.
  const value = await waitFor('the restored buffer to contain the typed marker', async () => {
    const v = await docText(editor)
    return v.includes(MARKER) ? v : false
  })
  check('the restored buffer holds the typed text', value.includes(MARKER))
  check('the restored buffer holds the pre-quit tail', value.includes('TAIL'))

  // All role="status" nodes, not the first: AssetEditor gives validation warnings that role
  // too, and a skill with a warning would otherwise shadow the banner.
  const banner = await editor.evalJs(
    `Array.from(document.querySelectorAll('[role="status"]')).map((n) => n.textContent).join(' | ')`
  )
  check('the restore banner names the draft', /Restored unsaved draft from/.test(banner), banner)

  // The discard path, so the scratch home is left clean for the next run.
  await editor.evalJs(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /discard draft/i.test(x.textContent))
    b.click()
    return true
  })()`)
  await sleep(1500)
  check('Discard draft removes it from disk', readDrafts().length === 0, readDrafts().length)

  editor.close()
  main.close()
  report()
}

if (PHASE === 'compare') {
  const { main, editor } = await openEditor()

  // aria-label is `skill · <name>` — same convention cdp-editor-window.mjs relies on. Read it
  // back rather than hardcoding a name so this does not assume which skill the scratch home
  // seeded.
  const skillName = await editor.evalJs(
    `document.querySelector(${JSON.stringify(SURFACE)}).getAttribute('aria-label').replace(/^skill\\s*\\u00b7\\s*/, '')`
  )

  // 1. Type a marker into the buffer, through real Input events (see the `arm` phase above for
  // why a direct property assignment reaches CodeMirror's DOM but never its state).
  await focusEnd(editor)
  await editor.insertText(`\n${MARKER}\n`)
  const typed = await waitFor('the marker to land in the buffer', async () => {
    const v = await docText(editor)
    return v.includes(MARKER) ? v : false
  })
  check('the marker was typed into the buffer', typed.includes(MARKER))

  // 2. Change SKILL.md on disk directly — not through the app — so the buffer's `baseHash`
  // (taken when the editor opened) goes stale. This is the one step no in-process test can do:
  // it needs a second, independent writer racing the open buffer.
  const skillFile = path.join(HOME, 'skills-user', skillName, 'SKILL.md')
  const onDiskBeforeMutation = fs.readFileSync(skillFile, 'utf8')
  fs.writeFileSync(
    skillFile,
    `${onDiskBeforeMutation}\n<!-- changed on disk by the gate -->\n`,
    'utf8'
  )

  // 3. Click Save; it will be rejected (the hash the buffer opened with no longer matches disk),
  // which is what raises the conflict banner.
  await editor.evalJs(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Save')
    b.click()
    return true
  })()`)
  const banner = await waitFor('the conflict banner', async () => {
    const text = await editor.evalJs(
      `Array.from(document.querySelectorAll('[role="status"]')).map((n) => n.textContent).join(' | ')`
    )
    return /changed on disk|saved version is newer/i.test(text) ? text : false
  })
  check('Save is rejected and the conflict banner appears', true, banner)

  // 4. Click Compare; assert the diff appeared AND that the editor wrapper really is
  // `display:none` — the one thing jsdom cannot check, because it loads no stylesheet and so
  // never applies Tailwind's `hidden` class to anything.
  await editor.evalJs(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /^compare$/i.test(x.textContent.trim()))
    b.click()
    return true
  })()`)
  const diffAppeared = await waitFor('the diff view to appear', () =>
    editor.evalJs(
      `!!document.querySelector('[role="group"][aria-label="On disk compared with Yours"]')`
    )
  )
  check('the diff view appears after Compare', diffAppeared)

  const wrapperDisplayWhileComparing = await editor.evalJs(`(() => {
    const ta = document.querySelector(${JSON.stringify(SURFACE)})
    let el = ta
    while (el && !el.classList.contains('hidden')) el = el.parentElement
    return el ? getComputedStyle(el).display : 'NO WRAPPER FOUND'
  })()`)
  check(
    'the editor wrapper is display:none while comparing (the CSS jsdom cannot check)',
    wrapperDisplayWhileComparing === 'none',
    wrapperDisplayWhileComparing
  )

  // 5. Click Back; assert the surface still contains the marker — the exact assertion that
  // would have caught Finding 1's data-loss bug, where Back used to remount AssetEditor and
  // silently re-run `init.load`'s original closure, reverting every keystroke typed since the
  // tab opened — and that the wrapper is visible again.
  await editor.evalJs(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /^back$/i.test(x.textContent.trim()))
    b.click()
    return true
  })()`)
  const valueAfterBack = await waitFor('the buffer after Back', async () => {
    const v = await docText(editor)
    return v.length > 0 ? v : false
  })
  check(
    'Back does not revert the marker text (the data-loss regression Finding 1 fixed)',
    valueAfterBack.includes(MARKER),
    valueAfterBack.slice(-60)
  )

  const wrapperDisplayAfterBack = await editor.evalJs(`(() => {
    const ta = document.querySelector(${JSON.stringify(SURFACE)})
    let el = ta
    while (el && !el.classList.contains('contents')) el = el.parentElement
    return el ? getComputedStyle(el).display : 'NO WRAPPER FOUND'
  })()`)
  check(
    'the editor wrapper is visible again after Back',
    wrapperDisplayAfterBack !== 'none',
    wrapperDisplayAfterBack
  )

  // Cleanup, so a re-run of this phase (or a later arm/check pass) against the same scratch
  // home starts from the same footing: restore SKILL.md to its pre-mutation bytes, and discard
  // the draft this scenario queued (through the same renderer API the app itself uses — the
  // draft is real, on disk, and persist-before-adopt means only main's own discard is trusted
  // to remove it).
  fs.writeFileSync(skillFile, onDiskBeforeMutation, 'utf8')
  await editor.evalJs(
    `window.argus.editor.discardDraft({ kind: 'skill', name: ${JSON.stringify(skillName)} })`
  )

  editor.close()
  main.close()
  report()
}
