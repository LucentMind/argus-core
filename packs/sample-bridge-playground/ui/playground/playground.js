const out = document.getElementById('out')
const show = (label, v) => {
  out.textContent = `${label}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`
}
const fail = (label, e) => show(`${label} — ERROR`, String(e && e.message ? e.message : e))

const buttons = [
  ['getCaseContext', () => window.argus.getCaseContext()],
  ['requestEvidence("error")', () => window.argus.requestEvidence('error')],
  ['readEvidence(1)', () => window.argus.readEvidence(1)],
  ['cite(evidence/sample.txt:1)', async () => {
    const ctx = await window.argus.getCaseContext()
    return window.argus.cite('evidence/sample.txt', (ctx && ctx.focus && ctx.focus.line) || 1)
  }],
  ['emitFinding({...})', () =>
    window.argus.emitFinding({ title: 'Playground finding', markdown: 'From the bridge playground.' })],
  ['sendToAgent("investigate")', () => window.argus.sendToAgent('Investigate the playground note.')]
]

const host = document.getElementById('controls')
for (const [label, fn] of buttons) {
  const b = document.createElement('button')
  b.textContent = label
  const verb = label.split('(')[0]
  b.disabled = typeof window.argus?.[verb] !== 'function'
  b.onclick = async () => {
    try {
      show(label, await fn())
    } catch (e) {
      fail(label, e)
    }
  }
  host.appendChild(b)
}
