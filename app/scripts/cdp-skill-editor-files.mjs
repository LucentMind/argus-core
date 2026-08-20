#!/usr/bin/env node
/**
 * Live CDP gate for the editor's sibling-file surface (spec §11, increment 4).
 *
 * jsdom cannot see any of this path: there is no main process, no real tier resolution
 * (`skillFiles.ts`'s `winner()` walks `TIERS` against real directories under a real
 * `ARGUS_HOME`), no real `skill_asset_reviews` row, and no second `BrowserWindow` — every
 * renderer test mocks `CodeSurface` as a `<textarea>` and never puts two of them on screen at
 * once. This drives the REAL app over CDP and proves increments 1-4 join up: a sibling written
 * through the editor's Save is the exact byte sequence `skill_asset_reviews` records with
 * `origin: 'editor'`, which is what increment 3's run gate reads back.
 *
 * Usage:
 *   1. ARGUS_HOME=<scratch> npx electron-vite dev --remoteDebuggingPort 9250
 *   2. ARGUS_HOME=<scratch> CDP_PORT=9250 node scripts/cdp-skill-editor-files.mjs
 *
 * Exits 0 when every check passes, 1 when a check fails, 2 when the IDENTITY assertion fails —
 * see `argus-cdp-port-collision` and `argus-vacuous-live-assertions`: two prior sessions in this
 * project passed a CDP gate for the wrong reason, once by driving a different branch's app on a
 * shared port and once by asserting on a screen that was not the one under test. The identity
 * check below is filesystem-anchored, not a name match: `collect-logs/SKILL.md` is written into
 * OUR scratch home with `fs`, carrying a marker string unique to this run, and the app must read
 * those exact bytes back through `window.argus.skills.read` — an app booted against any other
 * `ARGUS_HOME`, or one serving a stale in-memory copy, cannot produce them.
 *
 * Safe to re-run: `seed()` removes and rewrites both fixture skill directories every time, and
 * nothing this script writes lives outside `ARGUS_HOME`.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  listTargets,
  connect,
  mainWindow,
  waitFor,
  check,
  report,
  VISIBLE_SURFACE,
  VISIBLE_PANEL,
  focusVisibleEnd,
  toEditorMode
} from './lib/cdp.mjs'

const PORT = process.env.CDP_PORT || '9250'
const HOME = process.env.ARGUS_HOME
if (!HOME) {
  console.error('ARGUS_HOME is required (the scratch home the app was booted against)')
  process.exit(2)
}

const SKILL = 'collect-logs'
const SIBLING_REL = 'scripts/collect.sh'
const LOCKED_SKILL = 'collect-logs-locked'
const LOCKED_REL = 'scripts/probe.sh'
const NEW_FILE = 'notes/todo.txt'
const RENAMED_FILE = 'notes/todo-done.txt'

/** Unique per run's worth of intent, not per invocation: distinctive enough that finding it
 *  anywhere in the DOM or on disk can only mean THIS script's bytes, never another fixture's or
 *  a leftover from a previous run of a different gate sharing the port list. */
const MARKER = 'ARGUS-SKILL-EDITOR-FILES-GATE-7c14db'
const EDIT_LINE = `echo "${MARKER}: edited in the editor"`
const UNDO_MARKER = `${MARKER}-UNDO-PROBE`

const SIBLING_BODY = ['#!/bin/sh', `echo "${MARKER}: collecting logs"`, ''].join('\n')
const LOCKED_BODY = ['#!/bin/sh', `echo "${MARKER}: locked probe"`, ''].join('\n')

const skillMd = (name, blurb, runLine) =>
  ['---', `name: ${name}`, `description: ${blurb}`, '---', '', `# ${name}`, '', runLine, ''].join(
    '\n'
  )

const SKILL_MD_BODY = skillMd(
  SKILL,
  'Collect diagnostic logs for a case (fixture for the editor files gate).',
  `Run \`${SIBLING_REL}\` to gather the logs. Marker: ${MARKER}.`
)
const LOCKED_MD_BODY = skillMd(
  LOCKED_SKILL,
  'A HiveMind-tier fixture — read-only in the editor.',
  `Run \`${LOCKED_REL}\`. Marker: ${MARKER}.`
)

const userSkillDir = path.join(HOME, 'skills-user', SKILL)
const hiveSkillDir = path.join(HOME, 'skills-hivemind', LOCKED_SKILL)
const siblingAbs = path.join(userSkillDir, ...SIBLING_REL.split('/'))
const newFileAbs = path.join(userSkillDir, ...NEW_FILE.split('/'))
const renamedFileAbs = path.join(userSkillDir, ...RENAMED_FILE.split('/'))

/** Seed both fixture skills directly with `fs`, per the brief — no proposal, no accept flow.
 *  Removed and rewritten every run so the gate is idempotent. */
function seed() {
  fs.rmSync(userSkillDir, { recursive: true, force: true })
  fs.rmSync(hiveSkillDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(userSkillDir, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(userSkillDir, 'SKILL.md'), SKILL_MD_BODY)
  fs.writeFileSync(siblingAbs, SIBLING_BODY)

  fs.mkdirSync(path.join(hiveSkillDir, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(hiveSkillDir, 'SKILL.md'), LOCKED_MD_BODY)
  fs.writeFileSync(path.join(hiveSkillDir, ...LOCKED_REL.split('/')), LOCKED_BODY)
}

// ---------- page helpers (editor window) ----------
let editor

const visibleDoc = () =>
  editor.evalJs(`(() => { const e = ${VISIBLE_SURFACE}; return e ? e.innerText : null })()`)

const visibleEditable = () =>
  editor.evalJs(
    `(() => { const e = ${VISIBLE_SURFACE}; return e ? e.getAttribute('contenteditable') : null })()`
  )

/** Text of every `role="status"` banner inside the visible pane only — every hidden pane has its
 *  own, and they are all in the DOM at once (spec §6.1). */
const visibleStatus = () =>
  editor.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    if (!p) return null
    return Array.from(p.querySelectorAll('[role="status"]')).map((n) => n.textContent).join(' | ')
  })()`)

/** Click a button by its exact trimmed text, scoped to the visible pane's dock — the Files rows
 *  and the "Add file…"/"Rename"/"Delete" affordances are per-pane state, so an unscoped query
 *  could land on another tab's identical control. */
const clickInPane = (matcher) =>
  editor.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    if (!p) return false
    const b = Array.from(p.querySelectorAll('button')).find((x) => ${matcher})
    if (!b) return false
    b.click()
    return true
  })()`)

/** The Files dock rows visible in the on-screen pane: `[relPath, execMarker, hasRename,
 *  hasDelete]` for each row FilesPanel rendered. Reading structure rather than the flattened
 *  text keeps "exec marker present" and "mutation buttons present" independently assertable. */
const filesDockRows = () =>
  editor.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    if (!p) return null
    const list = p.querySelector('ul')
    if (!list) return []
    return Array.from(list.querySelectorAll('li')).map((li) => {
      const path = li.querySelector('button')?.textContent?.trim() || ''
      const exec = Array.from(li.querySelectorAll('span')).some((s) => s.textContent.trim() === 'exec')
      const hasRename = !!Array.from(li.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').startsWith('Rename'))
      const hasDelete = !!Array.from(li.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').startsWith('Delete'))
      return { path, exec, hasRename, hasDelete }
    })
  })()`)

const filesTabPresent = () =>
  editor.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    if (!p) return false
    return !!Array.from(p.querySelectorAll('[role="tab"]')).find((x) => (x.getAttribute('aria-label') || '') === 'Files')
  })()`)

const addFilePresent = () =>
  editor.evalJs(`(() => {
    const p = ${VISIBLE_PANEL}
    if (!p) return false
    return !!Array.from(p.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Add file…')
  })()`)

const openFilesTab = () => clickInPane(`(x.getAttribute('aria-label') || '') === 'Files'`)

/**
 * `role="tab"` is not unique to the asset strip: every mounted `BottomDock` (Problems /
 * References / Files, one set per pane, and every pane stays mounted per spec §6.1) ALSO renders
 * `role="tab"` buttons, so an unscoped `[role="tab"]` query counts those in too — a skill with
 * its Files dock open contributes a phantom tab, and `tabCount() === 2` never becomes true once
 * a second pane's dock is open. `TabBar`'s own tabs are the only ones whose accessible name ends
 * in the literal `" (tab)"` suffix (see `TabBar.tsx`), which is what this selector keys on.
 */
const ASSET_TAB_SEL = `[role="tab"][aria-label$="(tab)"]`

const tabCount = () => editor.evalJs(`document.querySelectorAll('${ASSET_TAB_SEL}').length`)

const tabLabels = () =>
  editor.evalJs(
    `Array.from(document.querySelectorAll('${ASSET_TAB_SEL}')).map((t) => t.getAttribute('aria-label'))`
  )

/** Click the Nth tab in strip order (0-indexed). Never by name/label: a sibling tab and its
 *  skill's own SKILL.md tab carry the SAME accessible name — `TabBar` labels a tab
 *  `${kind} · ${t.name}`, and `t.name` is the skill's name whether or not `t.file` is set (see
 *  `tabs.ts`'s `Tab.name` doc comment). Position is the only thing that disambiguates them. */
const clickTabAt = (index) =>
  editor.evalJs(`(() => {
    const t = document.querySelectorAll('${ASSET_TAB_SEL}')[${index}]
    if (!t) return false
    t.click()
    return true
  })()`)

const ctrlS = () => editor.key('s', { modifiers: 2, code: 'KeyS', keyCode: 83 })

const openAsset = (main, name, file) =>
  main.evalJs(
    `window.argus.editor.open(${JSON.stringify({ kind: 'skill', name, mode: 'edit', ...(file ? { file } : {}) })}).then(() => true)`
  )

const dismissOnboarding = (main) =>
  main.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Skip setup')
    if (!b) return false
    b.click()
    return true
  })()`)

const openEditorWindow = async () => {
  let target = null
  await waitFor('the editor window', async () => {
    target = (await listTargets(PORT)).find((t) => t.url.includes('editor.html'))
    return !!target
  })
  editor = await connect(target)
  await waitFor(
    'the CodeMirror surface to render',
    async () => (await editor.evalJs(`document.querySelectorAll('.cm-content').length`)) > 0
  )
  await toEditorMode(editor)
}

// ---------- the gate ----------
const main = async () => {
  seed()
  console.error(`seeded ${userSkillDir} and ${hiveSkillDir}`)

  const targets = await waitFor(
    `a page target on ${PORT}`,
    async () => {
      const t = await listTargets(PORT).catch(() => [])
      return t.length ? t : null
    },
    30_000
  )
  const app = await connect(mainWindow(targets))
  console.error(`connected to ${PORT}: ${targets.map((t) => t.url).join(', ')}`)
  if (await dismissOnboarding(app)) console.error('dismissed the setup wizard')

  // ---- IDENTITY, before anything else ----
  // Not a name match: `SKILL_MD_BODY` was written by THIS process into THIS scratch home with
  // `fs`, and it carries `MARKER`, a string unique to this run. An app reading any other
  // `ARGUS_HOME` — another branch's window that happens to own the port — physically cannot hand
  // these exact bytes back through `skills.read`.
  const readBack = await waitFor(
    'the app to read our seeded SKILL.md back byte-for-byte',
    async () => {
      const payload = await app.evalJs(`window.argus.skills.read(${JSON.stringify(SKILL)})`)
      return payload && payload.content === SKILL_MD_BODY ? payload : null
    },
    20_000
  ).catch(() => null)
  if (!readBack) {
    console.error(
      `IDENTITY FAIL: the app on port ${PORT} did not read back our seeded SKILL.md for "${SKILL}" ` +
        `from ${HOME}. Refusing to continue — this is either a different branch's app on a shared ` +
        `port, or it is not reading our ARGUS_HOME.`
    )
    process.exit(2)
  }
  check('identity: the app on this port reads our scratch ARGUS_HOME byte-for-byte', true, {
    port: PORT,
    home: HOME,
    skill: SKILL,
    hash: readBack.hash
  })

  // ---- 1. open the editor on the skill; the Files dock lists the sibling ----
  const opened = await openAsset(app, SKILL)
  if (opened !== true) throw new Error('window.argus.editor.open did not resolve')
  await openEditorWindow()
  await waitFor('the Files tab to appear in the dock', filesTabPresent)
  await openFilesTab()
  const rowsAfterOpen = await waitFor('the sibling to appear in the Files dock', async () => {
    const rows = await filesDockRows()
    return rows && rows.some((r) => r.path === SIBLING_REL) ? rows : null
  })
  const siblingRow = rowsAfterOpen.find((r) => r.path === SIBLING_REL)
  check(
    'files dock lists the sibling',
    Array.isArray(rowsAfterOpen) && siblingRow?.exec === true,
    rowsAfterOpen
  )

  // ---- 2. opening the sibling opens its own tab ----
  const tabsBeforeSibling = await tabLabels()
  const skillMdContentBefore = await visibleDoc()
  await clickInPane(`x.textContent.trim() === ${JSON.stringify(SIBLING_REL)}`)
  const tabsAfterSibling = await waitFor('a second tab for the sibling', async () => {
    const t = await tabLabels()
    return t.length === tabsBeforeSibling.length + 1 ? t : null
  })
  const siblingDoc = await waitFor('the sibling bytes on the visible surface', async () => {
    const d = await visibleDoc()
    return d && d.includes('collecting logs') ? d : null
  })
  check(
    'opening the sibling opens its own tab',
    tabsAfterSibling.length === 2 &&
      tabsAfterSibling.filter((l) => l.includes(SKILL)).length === 2 &&
      siblingDoc.includes(SIBLING_BODY.trim()),
    {
      tabsBeforeSibling,
      tabsAfterSibling,
      skillMdContentBefore: skillMdContentBefore?.slice(0, 40)
    }
  )

  // ---- 3. edit and save the sibling ----
  await focusVisibleEnd(editor)
  await editor.insertText(`\n${EDIT_LINE}\n`)
  await waitFor('the edit on the visible surface', async () =>
    (await visibleDoc()).includes(EDIT_LINE)
  )
  await ctrlS()
  const onDiskAfterEdit = await waitFor(
    'the edited bytes to reach disk',
    () => {
      try {
        const c = fs.readFileSync(siblingAbs, 'utf8')
        return c.includes(EDIT_LINE) ? c : null
      } catch {
        return null
      }
    },
    15_000
  ).catch(() => null)
  check('the bytes reached disk', onDiskAfterEdit !== null, {
    path: siblingAbs,
    onDisk: onDiskAfterEdit?.slice(-80) ?? null
  })

  const db = new DatabaseSync(path.join(HOME, 'argus.db'), { readOnly: true })
  const reviewRow = await waitFor(
    'a skill_asset_reviews row for the sibling',
    () => {
      const r = db
        .prepare(`SELECT sha256, origin FROM skill_asset_reviews WHERE skill = ? AND rel_path = ?`)
        .get(SKILL, SIBLING_REL)
      return r ?? null
    },
    15_000
  ).catch(() => null)
  // Same algorithm as `sha256Hex` in `skillAssetReviews.ts` (sha256 over the utf8 content, hex
  // digest) — computed here with `node:crypto` directly rather than round-tripped through the
  // renderer's `crypto.subtle`, since the two are guaranteed to agree and this needs no app
  // involvement at all.
  const expectedHash = onDiskAfterEdit
    ? crypto.createHash('sha256').update(onDiskAfterEdit, 'utf8').digest('hex')
    : null
  check(
    'the save recorded a review row',
    reviewRow !== null &&
      reviewRow.origin === 'editor' &&
      onDiskAfterEdit !== null &&
      reviewRow.sha256 === expectedHash,
    { reviewRow, expectedHash }
  )
  db.close()

  // ---- 4. undo history is per file ----
  // Only one sibling was seeded (per the brief), so the second tab IS the sibling's — the first
  // tab (index 0) is the skill's own SKILL.md, still open since step 1 and never touched. Typing
  // into the sibling (already the active/second tab) and reading the FIRST tab back is exactly
  // the "two documents, two undo histories" property; it does not need a second sibling file to
  // be meaningful, because SKILL.md and the sibling are already two independent buffers.
  await editor.insertText(`\n${UNDO_MARKER}\n`)
  await waitFor('the undo probe on the sibling surface', async () =>
    (await visibleDoc()).includes(UNDO_MARKER)
  )
  check('switching to the SKILL.md tab', await clickTabAt(0))
  const skillMdAfterProbe = await waitFor('the SKILL.md tab back on screen', async () => {
    const d = await visibleDoc()
    return d !== null && d.includes(SKILL) ? d : null
  })
  check(
    'undo history is per file',
    !skillMdAfterProbe.includes(UNDO_MARKER) && !skillMdAfterProbe.includes(EDIT_LINE),
    skillMdAfterProbe.slice(0, 120)
  )

  // ---- 5. add a file through the dock ----
  await openFilesTab()
  check('Add file… is offered', await clickInPane(`x.textContent.trim() === 'Add file…'`))
  await waitFor('the file-name dialog', () =>
    editor.evalJs(`!!document.querySelector('input[aria-label="File path"]')`)
  )
  await editor.evalJs(`(() => {
    const i = document.querySelector('input[aria-label="File path"]')
    i.focus()
    return true
  })()`)
  await editor.insertText(NEW_FILE)
  await waitFor('the new path in the dialog', () =>
    editor.evalJs(
      `document.querySelector('input[aria-label="File path"]').value === ${JSON.stringify(NEW_FILE)}`
    )
  )
  // Scoped to the dialog, never `document`-wide: `FileNameDialog`'s confirm button text is just
  // its `confirmLabel` ("Add"/"Rename"), and `FilesPanel` renders "Rename"/"Delete" affordance
  // buttons with that exact same bare text on every editable row — an unscoped `find` would grab
  // whichever renders first in DOM order, not the dialog's own button.
  await editor.evalJs(`(() => {
    const d = document.querySelector('[role="dialog"]')
    const b = d && Array.from(d.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Add')
    if (!b) return false
    b.click()
    return true
  })()`)
  // `waitFor` loops until its predicate returns something truthy — an empty string (the file's
  // actual content: `writeFile(name, relPath, '', null)`) is falsy, so polling for the CONTENT
  // never converges. Poll for existence instead and read the content once, after.
  const newFileExists = await waitFor(
    'the new sibling to land on disk',
    () => (fs.existsSync(newFileAbs) ? true : null),
    15_000
  ).catch(() => false)
  const newFileOnDisk = newFileExists ? fs.readFileSync(newFileAbs, 'utf8') : null
  check('a new sibling lands in the skill directory', newFileExists && newFileOnDisk === '', {
    path: newFileAbs,
    exists: fs.existsSync(newFileAbs),
    content: newFileOnDisk
  })

  // A brand-new file opens straight into its own tab (AssetPane.confirmFileDialog); the dock now
  // belongs to THAT tab, so re-open Files there before renaming.
  await waitFor('a third tab for the new file', async () => (await tabCount()) === 3)
  await openFilesTab()
  await waitFor('the new file listed in the dock', async () => {
    const rows = await filesDockRows()
    return rows && rows.some((r) => r.path === NEW_FILE) ? rows : null
  })

  // ---- 6. rename it ----
  check(
    `Rename ${NEW_FILE} is offered`,
    await clickInPane(
      `(x.getAttribute('aria-label') || '') === ${JSON.stringify(`Rename ${NEW_FILE}`)}`
    )
  )
  await waitFor('the rename dialog', () =>
    editor.evalJs(`!!document.querySelector('input[aria-label="File path"]')`)
  )
  await editor.evalJs(`(() => {
    const i = document.querySelector('input[aria-label="File path"]')
    i.focus()
    i.setSelectionRange(0, i.value.length)
    return true
  })()`)
  await editor.insertText(RENAMED_FILE)
  await waitFor('the renamed path in the dialog', () =>
    editor.evalJs(
      `document.querySelector('input[aria-label="File path"]').value === ${JSON.stringify(RENAMED_FILE)}`
    )
  )
  // Same collision as the Add dialog above: scope to the dialog, not the page.
  await editor.evalJs(`(() => {
    const d = document.querySelector('[role="dialog"]')
    const b = d && Array.from(d.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Rename')
    if (!b) return false
    b.click()
    return true
  })()`)
  const renamed = await waitFor(
    'the rename to land on disk',
    () => (fs.existsSync(renamedFileAbs) && !fs.existsSync(newFileAbs) ? true : null),
    15_000
  ).catch(() => false)
  check('rename moves the file', renamed === true, {
    oldPath: newFileAbs,
    oldExists: fs.existsSync(newFileAbs),
    newPath: renamedFileAbs,
    newExists: fs.existsSync(renamedFileAbs)
  })

  // ---- 7. delete it ----
  await waitFor('the renamed file listed in the dock', async () => {
    const rows = await filesDockRows()
    return rows && rows.some((r) => r.path === RENAMED_FILE) ? rows : null
  })
  check(
    `Delete ${RENAMED_FILE} is offered`,
    await clickInPane(
      `(x.getAttribute('aria-label') || '') === ${JSON.stringify(`Delete ${RENAMED_FILE}`)}`
    )
  )
  await waitFor('the delete confirm dialog', () =>
    editor.evalJs(`!!document.querySelector('[role="dialog"]')`)
  )
  await editor.evalJs(`(() => {
    const d = document.querySelector('[role="dialog"]')
    const b = Array.from(d.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Delete')
    if (!b) return false
    b.click()
    return true
  })()`)
  const deleted = await waitFor(
    'the delete to land on disk',
    () => (!fs.existsSync(renamedFileAbs) ? true : null),
    15_000
  ).catch(() => false)
  check('delete removes the file', deleted === true, {
    path: renamedFileAbs,
    stillExists: fs.existsSync(renamedFileAbs)
  })

  // ---- 8. a read-only (hivemind) skill offers no file mutations ----
  const openedLocked = await openAsset(app, LOCKED_SKILL)
  if (openedLocked !== true) throw new Error('opening the locked skill did not resolve')
  await waitFor('a fourth tab for the locked skill', async () => (await tabCount()) === 4)
  await waitFor('the locked skill on screen', async () => {
    const d = await visibleDoc()
    return d !== null && d.includes(LOCKED_SKILL) ? d : null
  })
  const lockedStatus = (await visibleStatus()) ?? ''
  const lockedEditable = await visibleEditable()
  await openFilesTab()
  const lockedRows = await waitFor('the locked sibling listed in the dock', async () => {
    const rows = await filesDockRows()
    return rows && rows.some((r) => r.path === LOCKED_REL) ? rows : null
  })
  const lockedAddPresent = await addFilePresent()
  check(
    'a read-only skill offers no file mutations',
    lockedRows.some((r) => r.path === LOCKED_REL) &&
      lockedRows.every((r) => !r.hasRename && !r.hasDelete) &&
      lockedAddPresent === false &&
      /is read-only/.test(lockedStatus) &&
      lockedEditable === 'false',
    { lockedRows, lockedAddPresent, lockedStatus, lockedEditable }
  )

  editor.close()
  app.close()
  report()
}

main().catch((e) => {
  console.error('GATE ERROR', e)
  process.exit(1)
})
