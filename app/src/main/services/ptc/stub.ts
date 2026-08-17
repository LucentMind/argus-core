/** Bump on ANY change to the generated stub text — the stub is prompt-adjacent surface
 *  (the model reads errors it produces) and Task 9 folds this into the distill prompt hash. */
export const PTC_STUB_VERSION = '2'

const BASE = String.raw`'use strict'
// argus_tools — generated. Call Argus tools from this script; only stdout returns to the model.
const net = require('node:net')
const PORT = Number(process.env.ARGUS_PTC_PORT)
const TOKEN = process.env.ARGUS_PTC_TOKEN || ''
let sock = null
let queue = Promise.resolve()
function connect() {
  if (sock) return sock
  sock = net.connect({ host: '127.0.0.1', port: PORT })
  sock.setEncoding('utf8')
  // Idle connection must not keep the script's process alive — a one-shot script has
  // to exit on its own once it is done, not wait to be SIGKILLed by the run.ts timeout.
  sock.unref()
  return sock
}
function callRaw(tool, args) {
  const s = connect()
  s.ref()
  return new Promise((resolve, reject) => {
    let acc = ''
    const onData = (d) => {
      acc += d
      const nl = acc.indexOf('\n')
      if (nl === -1) return
      s.off('data', onData); s.off('error', onError)
      s.unref()
      let res
      try { res = JSON.parse(acc.slice(0, nl)) } catch (e) { return reject(e) }
      res.ok ? resolve(res.result) : reject(new Error(res.error))
    }
    const onError = (e) => { s.off('data', onData); s.unref(); reject(e) }
    s.on('data', onData); s.on('error', onError)
    s.write(JSON.stringify({ tool, args, token: TOKEN }) + '\n')
  })
}
// No request ids on the wire — serialize every round-trip so concurrent callers
// (Promise.all in the model's script) cannot swap responses.
function call(tool, args) {
  const p = queue.then(() => callRaw(tool, args || {}))
  queue = p.then(() => {}, () => {})
  return p
}
function jsonParse(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''))
}
async function retry(fn, attempts = 3) {
  let last
  for (let i = 0; i < attempts; i++) {
    try { return await fn() } catch (e) { last = e; await new Promise((r) => setTimeout(r, 250 * 2 ** i)) }
  }
  throw last
}
module.exports = { call, jsonParse, retry }
`

export function generateStubModule(toolNames: string[]): string {
  const wrappers = toolNames
    .map((n) => `module.exports.${n} = (args) => call(${JSON.stringify(n)}, args)`)
    .join('\n')
  return BASE + wrappers + '\n'
}
