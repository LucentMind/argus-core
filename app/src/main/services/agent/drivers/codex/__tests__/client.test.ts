import { describe, expect, it } from 'vitest'
import { createCodexClientOverStreams } from '../client'

/**
 * Wire framing/envelope facts asserted below come from the empirical contract
 * (t3code `effect-codex-app-server`, `protocol.ts`/`protocol.test.ts`), NOT from the
 * plan's placeholder example tests:
 *   - JSONL, no `Content-Length` header, no `jsonrpc` field anywhere.
 *   - `id` is a client-assigned incrementing integer starting at 1.
 *   - `params` key is omitted entirely (never sent as `null`) when undefined.
 *   - Server-initiated id-bearing requests (approvals etc.) are answered by writing
 *     `{ id, result }` / `{ id, error }` with the SAME id, exactly like a response.
 */
describe('codex JSON-RPC stdio client', () => {
  it('assigns incrementing ids starting at 1 and omits jsonrpc/params on the wire', async () => {
    const { client, serverWrite, nextClientWrite } = createCodexClientOverStreams()
    await client.start()

    const first = client.request('initialize', { clientInfo: { name: 'argus' } })
    const firstSent = await nextClientWrite()
    expect(firstSent).toEqual({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'argus' } }
    })
    expect(firstSent).not.toHaveProperty('jsonrpc')
    serverWrite({ id: 1, result: { codexHome: '/tmp/codex-home' } })
    await expect(first).resolves.toEqual({ codexHome: '/tmp/codex-home' })

    const second = client.request('account/read')
    const secondSent = await nextClientWrite()
    expect(secondSent).toEqual({ id: 2, method: 'account/read' })
    expect(secondSent).not.toHaveProperty('params')
    serverWrite({ id: 2, result: { account: null } })
    await expect(second).resolves.toEqual({ account: null })
  })

  it('sends a notification with no id and omits params when undefined', async () => {
    const { client, nextClientWrite } = createCodexClientOverStreams()
    await client.start()

    client.notify('initialized')
    const sent = await nextClientWrite()
    expect(sent).toEqual({ method: 'initialized' })
    expect(sent).not.toHaveProperty('id')
    expect(sent).not.toHaveProperty('jsonrpc')
  })

  it('rejects the pending request on an error response', async () => {
    const { client, serverWrite, nextClientWrite } = createCodexClientOverStreams()
    await client.start()

    const pending = client.request('thread/resume', { threadId: 'missing' })
    await nextClientWrite()
    serverWrite({ id: 1, error: { code: -32601, message: 'Method not found: x/test' } })

    await expect(pending).rejects.toThrow('Method not found: x/test')
  })

  it('routes id-less inbound messages to onNotification', async () => {
    const { client, serverWrite } = createCodexClientOverStreams()
    await client.start()

    const received: Array<{ method: string; params?: unknown }> = []
    client.onNotification((msg) => received.push(msg))

    serverWrite({ method: 'item/agentMessage/delta', params: { delta: 'Hello', itemId: 'item-1' } })

    expect(received).toEqual([
      { method: 'item/agentMessage/delta', params: { delta: 'Hello', itemId: 'item-1' } }
    ])
  })

  it('routes an id-bearing inbound method message to onServerRequest and replies with the same id', async () => {
    const { client, serverWrite, nextClientWrite } = createCodexClientOverStreams()
    await client.start()

    client.onServerRequest(async (req) => {
      expect(req).toEqual({
        id: 77,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'item-1', command: 'rm -rf /tmp/x' }
      })
      return { decision: 'accept' }
    })

    serverWrite({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item-1', command: 'rm -rf /tmp/x' }
    })

    const reply = await nextClientWrite()
    expect(reply).toEqual({ id: 77, result: { decision: 'accept' } })
  })

  it('writes a -32603 error envelope when the onServerRequest callback throws', async () => {
    const { client, serverWrite, nextClientWrite } = createCodexClientOverStreams()
    await client.start()

    client.onServerRequest(async () => {
      throw new Error('handler exploded')
    })

    serverWrite({
      id: 78,
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'item-2' }
    })

    const reply = await nextClientWrite()
    expect(reply).toEqual({ id: 78, error: { code: -32603, message: 'handler exploded' } })
  })

  it('buffers a message split across two chunk boundaries', async () => {
    const { client, serverWrite } = createCodexClientOverStreams()
    await client.start()

    const received: Array<{ method: string; params?: unknown }> = []
    client.onNotification((msg) => received.push(msg))

    const line =
      JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'Hi' } }) + '\n'
    const splitAt = 10
    serverWrite(line.slice(0, splitAt))
    // Not yet parsed — the line is incomplete.
    expect(received).toEqual([])
    serverWrite(line.slice(splitAt))

    expect(received).toEqual([{ method: 'item/agentMessage/delta', params: { delta: 'Hi' } }])
  })

  it('tolerates blank lines between messages', async () => {
    const { client, serverWrite } = createCodexClientOverStreams()
    await client.start()

    const received: Array<{ method: string; params?: unknown }> = []
    client.onNotification((msg) => received.push(msg))

    serverWrite('\n')
    serverWrite({ method: 'turn/started', params: { threadId: 'thread-1' } })
    serverWrite('\n\n')

    expect(received).toEqual([{ method: 'turn/started', params: { threadId: 'thread-1' } }])
  })

  it('parses multiple complete lines delivered in a single chunk', async () => {
    const { client, serverWrite } = createCodexClientOverStreams()
    await client.start()

    const received: Array<{ method: string; params?: unknown }> = []
    client.onNotification((msg) => received.push(msg))

    const chunk =
      JSON.stringify({ method: 'turn/started', params: { threadId: 't1' } }) +
      '\n' +
      JSON.stringify({ method: 'turn/completed', params: { threadId: 't1' } }) +
      '\n'
    serverWrite(chunk)

    expect(received).toEqual([
      { method: 'turn/started', params: { threadId: 't1' } },
      { method: 'turn/completed', params: { threadId: 't1' } }
    ])
  })
})
