import crypto from 'node:crypto'
import net from 'node:net'

export interface PtcServerOpts {
  dispatch: (tool: string, args: Record<string, unknown>) => Promise<unknown>
  allowedTools: string[]
  maxCalls: number
}
export interface PtcServer {
  port: number
  token: string
  /** Dispatched (allowlist-passing, under-cap) calls so far. */
  calls: number
  close(): void
}

/** Loopback TCP, newline-delimited JSON {tool, args, token} → {ok, result|error}.
 *  TCP not AF_UNIX: unreliable on Windows (same conclusion Hermes reached). Token is
 *  compared as BYTES via timingSafeEqual — the wire value is attacker-shaped JSON. */
export function startPtcServer(opts: PtcServerOpts): Promise<PtcServer> {
  const token = crypto.randomBytes(24).toString('hex')
  const tokenBuf = Buffer.from(token)
  const state = { calls: 0 }
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8')
    let acc = ''
    sock.on('data', (chunk: string) => {
      acc += chunk
      let nl: number
      while ((nl = acc.indexOf('\n')) !== -1) {
        const line = acc.slice(0, nl)
        acc = acc.slice(nl + 1)
        void handleLine(line, sock)
      }
    })
    sock.on('error', () => sock.destroy())
  })

  async function handleLine(line: string, sock: net.Socket): Promise<void> {
    const reply = (o: object): void => {
      sock.write(JSON.stringify(o) + '\n')
    }
    let msg: { tool?: unknown; args?: unknown; token?: unknown }
    try {
      msg = JSON.parse(line)
    } catch {
      return reply({ ok: false, error: 'invalid JSON' })
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      return reply({ ok: false, error: 'invalid JSON' })
    }
    const supplied = Buffer.from(String(msg.token ?? ''))
    if (supplied.length !== tokenBuf.length || !crypto.timingSafeEqual(supplied, tokenBuf)) {
      return reply({ ok: false, error: 'invalid token' })
    }
    const tool = String(msg.tool ?? '')
    if (!opts.allowedTools.includes(tool)) {
      return reply({ ok: false, error: `tool "${tool}" is not allowed in scripts` })
    }
    if (state.calls >= opts.maxCalls) {
      return reply({ ok: false, error: `tool-call limit (${opts.maxCalls}) reached` })
    }
    state.calls++
    try {
      const args = (msg.args ?? {}) as Record<string, unknown>
      reply({ ok: true, result: await opts.dispatch(tool, args) })
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({
        port,
        token,
        get calls() {
          return state.calls
        },
        close: () => server.close()
      })
    })
  })
}
