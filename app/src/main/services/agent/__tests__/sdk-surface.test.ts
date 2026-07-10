import { describe, it, expect } from 'vitest'
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'

describe('sdk surface', () => {
  it('exports the entry points the agent layer builds on', () => {
    expect(typeof query).toBe('function')
    expect(typeof createSdkMcpServer).toBe('function')
    expect(typeof tool).toBe('function')
  })

  it('MCP SDK surface: client, transports, auth', () => {
    for (const f of [
      Client,
      StdioClientTransport,
      StreamableHTTPClientTransport,
      SSEClientTransport,
      auth
    ])
      expect(typeof f).toBe('function')
  })
})
