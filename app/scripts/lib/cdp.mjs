/**
 * Minimal CDP client for the runtime gates. No dependencies: node 22 has a global WebSocket
 * and fetch, which is the whole reason these scripts are plain .mjs.
 */
export const listTargets = async (port) =>
  (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(
    (t) => t.type === 'page' && !t.url.startsWith('devtools://')
  )

export const connect = async (target) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const send = (method, params) => {
    const id = ++nextId
    return new Promise((res) => {
      pending.set(id, res)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  return {
    close: () => ws.close(),
    /** Raw CDP. Exposed because driving a contenteditable needs the Input domain — a value
     *  assignment reaches CodeMirror's DOM but not its state, so the document never changes. */
    send,
    /** Type into whatever has focus, through the same beforeinput/input path as a real keyboard. */
    insertText: (text) => send('Input.insertText', { text }),
    /**
     * Press a key. `modifiers` is CDP's bitfield: 1 alt, 2 ctrl, 4 meta, 8 shift.
     *
     * `rawKeyDown` rather than `keyDown`: `keyDown` also generates a character, which for a
     * chord like Ctrl+Z would insert a control character alongside running the command.
     */
    key: async (name, { modifiers = 0, code, keyCode } = {}) => {
      const base = { key: name, code: code ?? `Key${name.toUpperCase()}`, modifiers }
      const vk = keyCode ?? name.toUpperCase().charCodeAt(0)
      await send('Input.dispatchKeyEvent', {
        ...base,
        type: 'rawKeyDown',
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk
      })
      await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
    },
    evalJs: async (expression) => {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (r.error) throw new Error(`CDP error: ${JSON.stringify(r.error)}`)
      if (r.result?.exceptionDetails) {
        throw new Error(
          `page threw: ${r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails)}`
        )
      }
      return r.result.result.value
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const waitFor = async (label, fn, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(300)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const assertions = []

export const check = (name, pass, detail) => {
  assertions.push({ name, pass: !!pass })
  console.error(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`
  )
}

/** Print the tally and exit non-zero if anything failed. */
export const report = () => {
  const failed = assertions.filter((a) => !a.pass)
  console.error(`\n${assertions.length - failed.length}/${assertions.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

/**
 * CodeMirror puts the `aria-label` on `.cm-content`, so the `${kind} · ${name}` convention the
 * textarea used still finds the editing surface — only the element changed.
 *
 * The middle dot is written as a literal character, **not** as `\\u00b7`. The existing gates use
 * the escape and are correct, but only because they interpolate it into a template literal that
 * the *page* then parses as JavaScript — the page's parser is what turns `·` into `·`. This
 * constant is passed through `JSON.stringify` instead, which escapes the backslash and hands the
 * page a selector matching a literal seven-character `·`. That silently matches nothing, and
 * presents as "the editor never rendered". Verified the hard way on 2026-07-31.
 */
export const SURFACE = '.cm-content[aria-label^="skill · "]'

/**
 * The document as text.
 *
 * CAVEAT, and it is why every gate fixture is a short file: CodeMirror virtualises long
 * documents, so `.cm-line` elements exist only for what is near the viewport. For a ~15-line
 * seeded skill everything is rendered and this is the whole document; for a 500-line file it
 * would not be, and an assertion built on it would fail for the wrong reason.
 */
export const docText = (conn) =>
  conn.evalJs(`document.querySelector(${JSON.stringify(SURFACE)}).innerText`)

/**
 * The main (non-editor) window.
 *
 * The existing gates use `listTargets()[0]`, which is the main window only on a fresh boot. Once
 * an editor window exists the order is not guaranteed, and picking `[0]` silently searches the
 * *editor* window for the Library — presenting as "the Library never loaded". Re-running any
 * phase against an already-open app hits this.
 */
export const mainWindow = async (targets) => targets.find((t) => !t.url.includes('editor.html'))

/**
 * Put the editor into a known view mode before asserting anything about it.
 *
 * `viewMode` is persisted, so a run that ends in Preview makes the *next* boot open in Preview —
 * where the surface is `inert`, every editor-scoped binding is correctly unreachable, and every
 * assertion that assumes Editor fails for the wrong reason. Normalise through the UI control:
 * do **not** `Page.reload` `editor.html` to reset, because main pushes the open tab on window
 * creation, so a reload leaves the window empty.
 */
export const toEditorMode = async (conn) => {
  const label = () =>
    conn.evalJs(
      `(() => { const b = [...document.querySelectorAll('button')].find(x => /^View mode:/.test(x.getAttribute('aria-label')||'')); return b ? b.getAttribute('aria-label') : null })()`
    )
  for (let i = 0; i < 3 && (await label()) !== 'View mode: Editor'; i++) {
    await conn.evalJs(
      `(() => { const b = [...document.querySelectorAll('button')].find(x => /^View mode:/.test(x.getAttribute('aria-label')||'')); if (b) b.click(); return 1 })()`
    )
    await sleep(400)
  }
}

/** Put the caret at the end of the document and focus it, so `insertText` appends. */
export const focusEnd = async (conn) => {
  await conn.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(SURFACE)})
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    return true
  })()`)
}
