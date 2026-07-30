#!/usr/bin/env node
/**
 * Draft-durability runtime gate (spec §8.3 step 5, §4.2–4.4).
 *
 * Two phases, because the assertion IS a process death — no in-process test can make it:
 *
 *   1. ARGUS_HOME=/tmp/argus-draft-gate npx electron-vite dev --remoteDebuggingPort 9223
 *      node scripts/cdp-editor-drafts.mjs arm      # types, checks the flush, quits the app
 *   2. ARGUS_HOME=/tmp/argus-draft-gate npx electron-vite dev --remoteDebuggingPort 9223
 *      node scripts/cdp-editor-drafts.mjs check    # reopens, checks the restore banner
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
import { listTargets as list, connect, sleep, waitFor, check, report } from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9223'
const HOME = process.env.ARGUS_HOME
const PHASE = process.argv[2]
const MARKER = 'CDP-DRAFT-MARKER'

if (!HOME) {
  console.error('ARGUS_HOME must be set to the same scratch home the app was booted with')
  process.exit(1)
}
if (PHASE !== 'arm' && PHASE !== 'check') {
  console.error('usage: cdp-editor-drafts.mjs arm|check')
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
    editor.evalJs(`!!document.querySelector('textarea[aria-label^="skill \\u00b7 "]')`)
  )
  return { main, editor }
}

if (PHASE === 'arm') {
  check('no drafts before typing', readDrafts().length === 0, readDrafts().length)

  const { main, editor } = await openEditor()

  // Type through the React value setter — assigning `.value` directly does not fire onChange.
  await editor.evalJs(`(() => {
    const ta = document.querySelector('textarea[aria-label^="skill \\u00b7 "]')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ta.value + '\\n${MARKER}\\n')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

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

  // §4.3: type again and quit inside the debounce window. This is the assertion that the
  // spec's renderer-side flush could not make — main-window close destroys the renderer first.
  await editor.evalJs(`(() => {
    const ta = document.querySelector('textarea[aria-label^="skill \\u00b7 "]')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ta.value + 'TAIL')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
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

  const value = await editor.evalJs(
    `document.querySelector('textarea[aria-label^="skill \\u00b7 "]').value`
  )
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
