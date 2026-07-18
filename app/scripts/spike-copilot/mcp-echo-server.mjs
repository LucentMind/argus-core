// Minimal stdio MCP server used only by scenario 6. Pure Node, no deps, no
// network: it speaks just enough of the Model Context Protocol (JSON-RPC 2.0
// over newline-delimited stdio) to advertise one tool, `mcp_echo`, and answer
// tools/call. Kept local so the spike never downloads or contacts anything.
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let req
  try {
    req = JSON.parse(text)
  } catch {
    return
  }
  const { id, method, params } = req
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'argus-spike-echo', version: '0.0.1' }
      }
    })
  } else if (method === 'notifications/initialized') {
    // no response for notifications
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
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
      }
    })
  } else if (method === 'tools/call') {
    const message = params?.arguments?.message ?? ''
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `mcp-echo:${message}` }], isError: false }
    })
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  }
})
