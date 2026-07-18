// HTTP-transport twin of mcp-echo-server.mjs, used by scenario 14. Pure Node,
// no deps, binds 127.0.0.1 only. Exposes the same single `mcp_echo` tool over
// BOTH remote MCP transports the SDK's MCPHTTPServerConfig can name:
//   - Streamable HTTP (POST <base>/mcp, JSON responses)  → type:"http"
//   - Legacy HTTP+SSE (GET <base>/sse + POST <base>/messages) → type:"sse"
// Every inbound request is reported through the `log` callback so the fixture
// captures exactly what the Copilot runtime sends (headers, body, ordering).
import http from 'node:http'

const TOOLS = [
  {
    name: 'mcp_echo',
    description: 'Echoes the provided message back (spike MCP server).',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message']
    }
  }
]

function rpcResult(req) {
  const { id, method, params } = req
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'argus-spike-echo-http', version: '0.0.1' }
      }
    }
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  }
  if (method === 'tools/call') {
    const message = params?.arguments?.message ?? ''
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `mcp-echo:${message}` }], isError: false }
    }
  }
  if (id !== undefined) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
  return null // notification — no response
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })
}

/** Start the server on an ephemeral 127.0.0.1 port. Returns
 *  { httpUrl, sseUrl, close } — httpUrl for type:"http", sseUrl for type:"sse". */
export function startHttpEcho(log = () => {}) {
  let sseClient = null // the single open legacy-SSE stream, if any
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const body = await readBody(req)
    log({
      method: req.method,
      path: url.pathname + url.search,
      headers: {
        accept: req.headers['accept'],
        'content-type': req.headers['content-type'],
        'mcp-session-id': req.headers['mcp-session-id'],
        'mcp-protocol-version': req.headers['mcp-protocol-version'],
        'user-agent': req.headers['user-agent']
      },
      body: body.slice(0, 2000)
    })

    // --- Streamable HTTP transport ---
    if (url.pathname === '/mcp' && req.method === 'POST') {
      let rpc
      try {
        rpc = JSON.parse(body)
      } catch {
        res.writeHead(400).end()
        return
      }
      const reply = rpcResult(rpc)
      if (!reply) {
        res.writeHead(202).end()
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'spike-http-session'
      })
      res.end(JSON.stringify(reply))
      return
    }
    if (url.pathname === '/mcp' && req.method === 'GET') {
      // No server-initiated stream; spec allows 405 here.
      res.writeHead(405).end()
      return
    }
    if (url.pathname === '/mcp' && req.method === 'DELETE') {
      res.writeHead(200).end()
      return
    }

    // --- Legacy HTTP+SSE transport ---
    if (url.pathname === '/sse' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write(`event: endpoint\ndata: /messages?session=spike\n\n`)
      sseClient = res
      req.on('close', () => {
        if (sseClient === res) sseClient = null
      })
      return
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      let rpc
      try {
        rpc = JSON.parse(body)
      } catch {
        res.writeHead(400).end()
        return
      }
      const reply = rpcResult(rpc)
      res.writeHead(202).end()
      if (reply && sseClient) {
        sseClient.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
      }
      return
    }

    res.writeHead(404).end()
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        httpUrl: `http://127.0.0.1:${port}/mcp`,
        sseUrl: `http://127.0.0.1:${port}/sse`,
        close: () =>
          new Promise((r) => {
            if (sseClient) sseClient.end()
            server.close(() => r())
            server.closeAllConnections?.()
          })
      })
    })
  })
}
