const out = document.getElementById('out')
const show = (label, v) => {
  out.textContent = `${label}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`
}
const fail = (label, e) => show(`${label} — ERROR`, String(e && e.message ? e.message : e))

const host = document.getElementById('controls')

// One row per verb: a run button + editable inputs so you can test against real
// case data. `run(inputs)` receives the row's input elements in order.
function row(verb, label, inputs, run) {
  const wrap = document.createElement('div')
  wrap.className = 'verb-row'
  const b = document.createElement('button')
  b.textContent = label
  b.disabled = typeof (window.argus && window.argus[verb]) !== 'function'
  const els = inputs.map((cfg) => {
    const el = document.createElement(cfg.textarea ? 'textarea' : 'input')
    if (!cfg.textarea) el.type = cfg.type || 'text'
    el.placeholder = cfg.placeholder
    if (cfg.value != null) el.value = cfg.value
    el.className = cfg.textarea ? 'verb-input verb-area' : 'verb-input'
    return el
  })
  b.onclick = async () => {
    try {
      show(label, await run(els))
    } catch (e) {
      fail(label, e)
    }
  }
  wrap.appendChild(b)
  els.forEach((el) => wrap.appendChild(el))
  host.appendChild(wrap)
  return els
}

row('getCaseContext', 'getCaseContext', [], async () => {
  const ctx = await window.argus.getCaseContext()
  // convenience: seed readEvidence/cite inputs from the focus, if any
  if (ctx && ctx.focus) {
    if (evidenceIdInput) evidenceIdInput.value = String(ctx.focus.evidenceId)
    if (citeLineInput && ctx.focus.line != null) citeLineInput.value = String(ctx.focus.line)
  }
  return ctx
})

row('requestEvidence', 'requestEvidence', [{ placeholder: 'query', value: 'error' }], (els) =>
  window.argus.requestEvidence(els[0].value)
)

const [evidenceIdInput] = row(
  'readEvidence',
  'readEvidence',
  [{ type: 'number', placeholder: 'evidence id', value: '1' }],
  (els) => window.argus.readEvidence(Number(els[0].value))
)

// argus-case:// read protocol (3d-1): render a case file directly. No bridge verb is
// involved — readCaseFiles gates the protocol handler, not a window.argus method — so this
// row gates its button on getCaseContext (which it also calls to learn the caseSlug).
let currentCaseSlug = ''
const caseImg = document.createElement('img')
caseImg.id = 'case-file-preview'
caseImg.style.maxWidth = '320px'
caseImg.style.display = 'none'
row(
  'getCaseContext',
  'render via argus-case://',
  [{ placeholder: 'path under evidence/ (e.g. photo.png)', value: 'sample.txt' }],
  async (els) => {
    if (!currentCaseSlug) {
      const ctx = await window.argus.getCaseContext()
      currentCaseSlug = ctx.caseSlug
    }
    // The URL path is relative to the case's evidence/ dir, but readEvidence() reports
    // relPaths already prefixed with "evidence/". Strip a leading "evidence/" (and any
    // leading slashes) so a pasted readEvidence relPath resolves correctly.
    const rel = els[0].value.replace(/^\/+/, '').replace(/^evidence\//, '')
    caseImg.src = `argus-case://${currentCaseSlug}/${rel}`
    caseImg.style.display = 'block'
    return { url: caseImg.src }
  }
)
host.appendChild(caseImg)

const citeEls = row(
  'cite',
  'cite',
  [
    { placeholder: 'relPath (e.g. evidence/foo.txt)', value: 'evidence/sample.txt' },
    { type: 'number', placeholder: 'line', value: '1' }
  ],
  (els) => window.argus.cite(els[0].value, Number(els[1].value))
)
const citeLineInput = citeEls[1]

row(
  'emitFinding',
  'emitFinding',
  [
    { placeholder: 'title', value: 'Playground finding' },
    { textarea: true, placeholder: 'markdown', value: 'From the bridge playground.' }
  ],
  (els) => window.argus.emitFinding({ title: els[0].value, markdown: els[1].value })
)

row(
  'sendToAgent',
  'sendToAgent',
  [{ placeholder: 'text to stage in the chat composer', value: 'Investigate the playground note.' }],
  (els) => window.argus.sendToAgent(els[0].value)
)

// Downstream: receive agent-dispatched commands and log them.
const logEl = document.createElement('div')
logEl.id = 'dispatch-log'
document.body.appendChild(
  Object.assign(document.createElement('h2'), { textContent: 'Agent dispatch log' })
)
document.body.appendChild(logEl)

if (window.argus && typeof window.argus.onCommand === 'function') {
  window.argus.onCommand((cmd, args) => {
    const line = document.createElement('div')
    line.className = 'log-line'
    line.textContent = `← ${cmd}(${JSON.stringify(args)})`
    logEl.prepend(line)
    if (cmd === 'highlight') return { ok: true, highlighted: Number(args[0]) }
    if (cmd === 'echo') return { ok: true, echo: String(args[0]) }
    return { ok: false, error: `unknown command: ${cmd}` }
  })
}
