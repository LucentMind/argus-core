import { describe, it, expect } from 'vitest'
import { captureFragments, captureTools } from '../captureInput'
import { NATIVE_TOOL_SPECS } from '../../agent/nativeTools'

describe('captureFragments', () => {
  it('pairs each fragment with its id, size and override state', () => {
    const out = captureFragments({
      fragments: ['IDENTITY', 'NEUTRAL RULES'],
      ids: ['persona.mode.investigation', 'persona.neutral'],
      activeOverrides: ['persona.neutral']
    })
    expect(out).toEqual([
      {
        id: 'persona.mode.investigation',
        label: 'persona.mode.investigation',
        chars: 8,
        overridden: false
      },
      { id: 'persona.neutral', label: 'persona.neutral', chars: 13, overridden: true }
    ])
  })

  it('labels registry-less fragments without inventing an id', () => {
    // Pack fragments are pack-owned text read off disk, and personaAppend is a user setting. Neither
    // is a registry entry, and neither can ever be "overridden" from the dev page.
    const out = captureFragments({
      fragments: ['PACK TEXT'],
      ids: [null],
      activeOverrides: ['persona.neutral']
    })
    expect(out).toEqual([
      { id: null, label: 'Pack or settings fragment', chars: 9, overridden: false }
    ])
  })

  it('tolerates an ids array shorter than the fragments array', () => {
    // Defensive: a future assembler change that appends a fragment without an id must degrade
    // to "unattributed", not throw during session construction.
    const out = captureFragments({
      fragments: ['A', 'B'],
      ids: ['persona.neutral'],
      activeOverrides: []
    })
    expect(out).toHaveLength(2)
    expect(out[1].id).toBeNull()
  })
})

describe('captureTools', () => {
  const pack = [
    { packId: 'p', windowId: 'w', cmd: 'go', risk: 'low' as const, args: [], description: 'Run it' }
  ]

  it('lists native tools for a driver that registers them', () => {
    const out = captureTools({
      driverKind: 'claude-agent-sdk',
      panelCommandDecls: [],
      connectorIds: []
    })
    expect(out).toHaveLength(NATIVE_TOOL_SPECS.length)
    expect(out.every((t) => t.origin === 'native')).toBe(true)
    expect(out.map((t) => t.name)).toContain('grep_lines')
  })

  it('omits native tools for a driver that does not register them', () => {
    // Codex and the ACP drivers never build the Argus MCP server, so claiming those tools
    // reached the model would be a lie the capture exists to prevent.
    const out = captureTools({ driverKind: 'cursor', panelCommandDecls: [], connectorIds: [] })
    expect(out.filter((t) => t.origin === 'native')).toEqual([])
  })

  it('resolves native descriptions through the injected resolver', () => {
    const out = captureTools({
      driverKind: 'claude-agent-sdk',
      resolve: (id) => `<<${id}>>`,
      panelCommandDecls: [],
      connectorIds: []
    })
    expect(out.find((t) => t.name === 'grep_lines')?.description).toBe(
      '<<tool.grep_lines.description>>'
    )
  })

  it('includes pack panel commands under their MCP tool name', () => {
    const out = captureTools({ driverKind: 'cursor', panelCommandDecls: pack, connectorIds: [] })
    expect(out).toEqual([{ name: 'mcp__p__w_go', description: 'Run it', origin: 'pack' }])
  })

  it('lists connector servers by id, with no tool names', () => {
    // Connector tools live in a remote server; Argus composes the server, never its tool list.
    const out = captureTools({
      driverKind: 'cursor',
      panelCommandDecls: [],
      connectorIds: ['jira']
    })
    expect(out).toEqual([
      {
        name: 'jira',
        description: 'Connector MCP server (tool list is remote)',
        origin: 'connector'
      }
    ])
  })
})
