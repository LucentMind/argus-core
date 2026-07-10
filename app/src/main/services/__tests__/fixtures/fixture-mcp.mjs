// Minimal stdio MCP server for integration tests. Uses the low-level Server
// class with raw JSON-Schema inputSchemas so it does not depend on any
// particular zod major (the app is zod 4; the MCP SDK nests zod 3).
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// secret-resolution canary: refuse to start unless the resolved token arrived
if (process.env.FIXTURE_REQUIRE_TOKEN === '1' && process.env.FIXTURE_TOKEN !== 'sesame') {
  process.exit(1)
}

const obj = { type: 'object', properties: {} }
const TOOLS = [
  { name: 'get_ticket', description: 'Read a ticket', inputSchema: obj },
  { name: 'add_comment', description: 'Write a comment', inputSchema: obj },
  { name: 'delete_ticket', description: 'Delete a ticket', inputSchema: obj },
  { name: 'frobnicate', description: 'Unclassifiable', inputSchema: obj }
]

const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: `ran ${req.params.name}` }]
}))
await server.connect(new StdioServerTransport())
