import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { DistillWorld } from '../../../../shared/distill'
import {
  PTC_DISTILL_MAX_CALLS,
  PTC_DISTILL_STDOUT_CAP,
  PTC_DISTILL_TIMEOUT_MS
} from '../../ptc/run'
import { createDistillMcpServer } from '../mcp'

function world(): DistillWorld {
  return {
    sessions: [
      {
        id: 1,
        title: 'only session',
        messages: [
          { role: 'user', content: 'the flaky NEEDLE test keeps failing' },
          { role: 'assistant', content: 'looking into it' }
        ]
      }
    ]
  }
}

async function connectedClient(
  w: DistillWorld
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createDistillMcpServer(w)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-distill-client', version: '1.0.0' })
  await Promise.all([client.connect(clientTransport), server.instance.connect(serverTransport)])
  return { client, close: async () => client.close() }
}

describe('createDistillMcpServer', () => {
  it('advertises list_sessions, read_transcript, search_transcript, run_tool_script', async () => {
    const { client, close } = await connectedClient(world())
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual([
        'list_sessions',
        'read_transcript',
        'run_tool_script',
        'search_transcript'
      ])
    } finally {
      await close()
    }
  })

  it('read_transcript is snapshot-served over the same world object', async () => {
    const { client, close } = await connectedClient(world())
    try {
      const res = await client.callTool({
        name: 'read_transcript',
        arguments: { session_id: 1 }
      })
      const content = res.content as { type: string; text: string }[]
      const parsed = JSON.parse(content[0].text)
      expect(parsed.total).toBe(2)
      expect(parsed.messages[0].content).toBe('the flaky NEEDLE test keeps failing')
    } finally {
      await close()
    }
  })

  it('run_tool_script dispatches search_transcript back into worldTools over the same world, with distiller PTC caps', async () => {
    const { client, close } = await connectedClient(world())
    try {
      const res = await client.callTool({
        name: 'run_tool_script',
        arguments: {
          script: `
              const t = require('./argus_tools')
              t.search_transcript({ query: 'needle' }).then((r) => console.log(JSON.stringify(r)))
            `
        }
      })
      const content = res.content as { type: string; text: string }[]
      const outer = JSON.parse(content[0].text)
      expect(outer.exit_code).toBe(0)
      expect(outer.timed_out).toBe(false)
      expect(outer.tool_calls).toBe(1)
      const inner = JSON.parse(outer.stdout.trim())
      expect(inner.hits).toHaveLength(1)
      expect(inner.hits[0]).toMatchObject({ sessionId: 1, index: 0, role: 'user' })
    } finally {
      await close()
    }
  }, 60_000)

  it('accepts explicit PTC distiller caps and uses the PTC_DISTILL_* defaults otherwise', async () => {
    // Explicit caps path: a maxCalls of 0 must refuse the very first script call.
    const server = createDistillMcpServer(world(), {
      maxCalls: 0,
      stdoutCapBytes: PTC_DISTILL_STDOUT_CAP,
      timeoutMs: PTC_DISTILL_TIMEOUT_MS
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-distill-client-2', version: '1.0.0' })
    await Promise.all([client.connect(clientTransport), server.instance.connect(serverTransport)])
    try {
      const res = await client.callTool({
        name: 'run_tool_script',
        arguments: {
          script: `
              const t = require('./argus_tools')
              t.list_sessions({}).then((r) => console.log(JSON.stringify(r))).catch((e) => console.log('ERR', e.message))
            `
        }
      })
      const content = res.content as { type: string; text: string }[]
      const outer = JSON.parse(content[0].text)
      expect(outer.stdout).toContain('tool-call limit (0) reached')
      expect(outer.tool_calls).toBe(0)
      expect(PTC_DISTILL_MAX_CALLS).toBe(200)
    } finally {
      await client.close()
    }
  }, 60_000)
})
