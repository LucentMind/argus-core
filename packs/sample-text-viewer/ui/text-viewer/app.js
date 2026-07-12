// Sample Text Viewer — the reference webPanel. Reads case evidence through the
// read-only window.argus bridge (getCaseContext/requestEvidence/readEvidence)
// and renders it with line numbers, in-panel find, and jump-to-focus.
const byId = (id) => document.getElementById(id)
const contentEl = byId('content')
const metaEl = byId('meta')
const findEl = byId('find')

function renderText(doc) {
  const lines = doc.content.split('\n')
  const frag = document.createDocumentFragment()
  lines.forEach((text, i) => {
    const n = doc.startLine + i
    const row = document.createElement('div')
    row.className = 'line'
    row.dataset.line = String(n)
    const ln = document.createElement('span')
    ln.className = 'ln'
    ln.textContent = String(n)
    const tx = document.createElement('span')
    tx.className = 'tx'
    tx.textContent = text
    row.append(ln, tx)
    if (doc.focusLine && n === doc.focusLine) row.classList.add('focus')
    frag.append(row)
  })
  contentEl.replaceChildren(frag)
  metaEl.textContent = `${doc.relPath}${doc.truncated ? ' · truncated' : ''}`
  if (doc.focusLine) {
    contentEl.querySelector(`.line[data-line="${doc.focusLine}"]`)?.scrollIntoView({ block: 'center' })
  }
}

function applyFind(query) {
  const needle = query.trim().toLowerCase()
  let first = null
  for (const row of contentEl.querySelectorAll('.line')) {
    const hit = needle.length > 0 && row.querySelector('.tx').textContent.toLowerCase().includes(needle)
    row.classList.toggle('hit', hit)
    if (hit && !first) first = row
  }
  first?.scrollIntoView({ block: 'center' })
}

async function renderSearch() {
  const wrap = document.createElement('div')
  wrap.className = 'search'
  const q = document.createElement('input')
  q.id = 'q'
  q.type = 'search'
  q.placeholder = 'Search evidence…'
  const results = document.createElement('div')
  wrap.append(q, results)
  contentEl.replaceChildren(wrap)
  q.addEventListener('input', async () => {
    const hits = q.value.trim() ? await window.argus.requestEvidence(q.value) : []
    const frag = document.createDocumentFragment()
    for (const h of hits) {
      const d = document.createElement('div')
      d.className = 'search-hit'
      d.textContent = `${h.relPath} — ${h.snippet}`
      d.addEventListener('click', async () => renderText(await window.argus.readEvidence(h.evidenceId, h.matchLine)))
      frag.append(d)
    }
    results.replaceChildren(frag)
  })
}

findEl.addEventListener('input', () => applyFind(findEl.value))

async function boot() {
  try {
    const ctx = window.argus.getCaseContext ? await window.argus.getCaseContext() : null
    if (ctx && ctx.focus && window.argus.readEvidence) {
      renderText(await window.argus.readEvidence(ctx.focus.evidenceId, ctx.focus.line))
    } else if (window.argus.requestEvidence) {
      await renderSearch()
    } else {
      contentEl.replaceChildren(Object.assign(document.createElement('div'), { className: 'notice', textContent: 'No evidence access was granted to this panel.' }))
    }
  } catch (err) {
    contentEl.replaceChildren(Object.assign(document.createElement('div'), { className: 'notice', textContent: `Error: ${err && err.message ? err.message : String(err)}` }))
  }
}

boot()
