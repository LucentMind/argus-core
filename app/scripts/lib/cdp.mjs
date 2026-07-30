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
