import { describe, it, expect } from 'vitest'
import {
  flattenPanelCommands,
  panelToolName,
  panelCommandRiskMap,
  buildPanelCommandTools,
  buildPanelCommandServers
} from '../panelCommands'

const windows = [
  {
    packId: 'pk',
    decl: {
      id: 'win',
      commands: [
        { id: 'highlight', risk: 'low' as const, args: ['line'] },
        { id: 'edit', risk: 'medium' as const, args: [] }
      ]
    }
  },
  { packId: 'pk2', decl: { id: 'w2', commands: [] } }
]

describe('flattenPanelCommands / panelToolName / panelCommandRiskMap', () => {
  it('flattens commands and builds tool names + risk map', () => {
    const decls = flattenPanelCommands(windows)
    expect(decls).toHaveLength(2)
    expect(panelToolName(decls[0])).toBe('mcp__pk__win_highlight')
    expect(panelCommandRiskMap(decls)).toEqual({
      mcp__pk__win_highlight: 'low',
      mcp__pk__win_edit: 'medium'
    })
  })
})

describe('buildPanelCommandTools', () => {
  it('builds one tool per command whose handler calls dispatch with positional args', async () => {
    const calls: unknown[] = []
    const tools = buildPanelCommandTools(
      flattenPanelCommands(windows),
      async (packId, windowId, cmd, args) => {
        calls.push([packId, windowId, cmd, args])
        return { ok: true, args }
      }
    )
    expect(tools.map((t) => ({ packId: t.packId, name: t.name }))).toEqual([
      { packId: 'pk', name: 'win_highlight' },
      { packId: 'pk', name: 'win_edit' }
    ])
    const highlight = tools.find((t) => t.name === 'win_highlight')!
    const out = await highlight.handler({ line: '42' })
    expect(calls).toEqual([['pk', 'win', 'highlight', ['42']]])
    expect(JSON.parse(out.content[0].text)).toMatchObject({ ok: true })
  })
})

describe('buildPanelCommandServers', () => {
  it('groups tools into one SDK server per pack, keyed by packId', () => {
    const servers = buildPanelCommandServers(flattenPanelCommands(windows), async () => ({
      ok: true
    }))
    // pk2 has no commands, so it gets no server
    expect(Object.keys(servers)).toEqual(['pk'])
    expect(servers.pk.name).toBe('pk')
    expect(servers.pk.type).toBe('sdk')
  })
})
