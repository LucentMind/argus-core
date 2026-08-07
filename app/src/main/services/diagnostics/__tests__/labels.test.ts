import { describe, it, expect } from 'vitest'
import {
  argv0Basename,
  resolveLabel,
  stdioConnectorCommands,
  type LabelSources,
  type WindowDescriptor
} from '../labels'
import type { ElectronProcessMetric, ProcessSample } from '../../../../shared/diagnostics'
import type { RegisteredLabel } from '../processLabels'

function sample(over: Partial<ProcessSample> & { pid: number }): ProcessSample {
  return {
    ppid: 1,
    startTimeMs: 1_000,
    runTimeMs: 5_000,
    name: `proc-${over.pid}`,
    command: `/bin/proc-${over.pid}`,
    status: 'Run',
    cpuTimeMs: 0,
    residentBytes: 0,
    ...over
  }
}

function metric(over: Partial<ElectronProcessMetric> & { pid: number }): ElectronProcessMetric {
  return { creationTimeMs: 1_000, type: 'Tab', ...over }
}

function sources(over: Partial<LabelSources> = {}): LabelSources {
  return { windows: [], connectors: [], registered: new Map(), ...over }
}

describe('resolveLabel — tier B (Electron)', () => {
  it('names the browser process', () => {
    const r = resolveLabel(sample({ pid: 10 }), metric({ pid: 10, type: 'Browser' }), sources())
    expect(r).toEqual({ kind: 'electron-internal', label: 'Argus main process', inferred: false })
  })

  it('names the GPU process', () => {
    const r = resolveLabel(sample({ pid: 11 }), metric({ pid: 11, type: 'GPU' }), sources())
    expect(r).toEqual({ kind: 'electron-internal', label: 'GPU process', inferred: false })
  })

  it('names a utility process by its service name', () => {
    const r = resolveLabel(
      sample({ pid: 12 }),
      metric({ pid: 12, type: 'Utility', serviceName: 'network.mojom.NetworkService' }),
      sources()
    )
    expect(r).toEqual({
      kind: 'electron-internal',
      label: 'Utility: network.mojom.NetworkService',
      inferred: false
    })
  })

  it('falls back to a bare utility label when Electron reports no service name', () => {
    const r = resolveLabel(sample({ pid: 13 }), metric({ pid: 13, type: 'Utility' }), sources())
    expect(r?.label).toBe('Utility process')
  })

  it('passes through an unrecognised Electron process type rather than dropping it', () => {
    const r = resolveLabel(sample({ pid: 14 }), metric({ pid: 14, type: 'Zygote' }), sources())
    expect(r).toEqual({ kind: 'electron-internal', label: 'Electron: Zygote', inferred: false })
  })

  it('names the main window', () => {
    const windows: WindowDescriptor[] = [{ osPid: 20, kind: 'main-window' }]
    const r = resolveLabel(sample({ pid: 20 }), metric({ pid: 20 }), sources({ windows }))
    expect(r).toEqual({ kind: 'electron-window', label: 'Main window', inferred: false })
  })

  it('names the editor window', () => {
    const windows: WindowDescriptor[] = [{ osPid: 21, kind: 'editor-window' }]
    const r = resolveLabel(sample({ pid: 21 }), metric({ pid: 21 }), sources({ windows }))
    expect(r).toEqual({ kind: 'electron-window', label: 'Editor window', inferred: false })
  })

  it('names a panel by its title', () => {
    const windows: WindowDescriptor[] = [{ osPid: 22, kind: 'panel', title: 'Log viewer' }]
    const r = resolveLabel(sample({ pid: 22 }), metric({ pid: 22 }), sources({ windows }))
    expect(r).toEqual({ kind: 'electron-panel', label: 'Panel: Log viewer', inferred: false })
  })

  it('joins both names when two same-origin windows share one renderer process', () => {
    const windows: WindowDescriptor[] = [
      { osPid: 23, kind: 'main-window' },
      { osPid: 23, kind: 'editor-window' }
    ]
    const r = resolveLabel(sample({ pid: 23 }), metric({ pid: 23 }), sources({ windows }))
    expect(r).toEqual({
      kind: 'electron-window',
      label: 'Main window + Editor window',
      inferred: false
    })
  })

  it('falls back to a generic renderer label when no descriptor matches the pid', () => {
    const windows: WindowDescriptor[] = [{ osPid: 99, kind: 'main-window' }]
    const r = resolveLabel(sample({ pid: 24 }), metric({ pid: 24 }), sources({ windows }))
    expect(r).toEqual({ kind: 'electron-internal', label: 'Renderer process', inferred: false })
  })

  it('returns null when there is no Electron metric and nothing else matches', () => {
    expect(resolveLabel(sample({ pid: 30 }), undefined, sources())).toBeNull()
  })
})

describe('argv0Basename', () => {
  it('strips directory, extension, and case', () => {
    expect(argv0Basename('C:\\Users\\x\\AppData\\bin\\Claude.EXE --flag')).toBe('claude')
    expect(argv0Basename('/usr/local/bin/copilot serve')).toBe('copilot')
  })

  it('strips surrounding quotes', () => {
    expect(argv0Basename('"C:\\Program Files\\argus\\codex.exe" app-server')).toBe('codex')
  })

  it('returns an empty string for an empty command', () => {
    expect(argv0Basename('   ')).toBe('')
  })
})

describe('resolveLabel — tier C (command-line inference)', () => {
  it.each([
    ['/usr/local/bin/claude --print', 'claude-agent-sdk', 'Claude driver'],
    ['C:\\bin\\copilot.exe --stdio', 'github-copilot', 'Copilot driver'],
    ['/opt/codex app-server', 'codex', 'Codex driver'],
    ['/usr/bin/cursor-agent --acp', 'cursor', 'Cursor driver'],
    ['/usr/bin/grok --acp', 'grok', 'Grok driver']
  ])('labels %s as a driver', (command, provider, label) => {
    const r = resolveLabel(sample({ pid: 40, command }), undefined, sources())
    expect(r).toEqual({ kind: 'driver', label, provider, inferred: true })
  })

  it('labels the graphify pack binary', () => {
    const r = resolveLabel(
      sample({ pid: 41, command: '/packs/code-graph/bin/graphify --repo .' }),
      undefined,
      sources()
    )
    expect(r).toEqual({ kind: 'pack-binary', label: 'graphify', inferred: true })
  })

  it.each([
    ['--type=renderer', 'Renderer process'],
    ['--type=gpu-process', 'GPU process'],
    ['--type=utility', 'Utility process']
  ])('labels an Electron descendant carrying %s', (flag, label) => {
    const r = resolveLabel(
      sample({ pid: 42, command: `/opt/argus/argus ${flag} --lang=en` }),
      undefined,
      sources()
    )
    expect(r).toEqual({ kind: 'electron-internal', label, inferred: true })
  })

  it('prefers the Electron metric over the --type= fallback', () => {
    const r = resolveLabel(
      sample({ pid: 43, command: '/opt/argus/argus --type=renderer' }),
      metric({ pid: 43, type: 'Tab' }),
      sources({ windows: [{ osPid: 43, kind: 'main-window' }] })
    )
    expect(r).toEqual({ kind: 'electron-window', label: 'Main window', inferred: false })
  })

  it('returns null for an unrecognised command', () => {
    expect(
      resolveLabel(sample({ pid: 44, command: '/usr/bin/node server.js' }), undefined, sources())
    ).toBeNull()
  })
})

describe('resolveLabel — tier C falls back to `name` when argv0 has an unquoted space', () => {
  it('resolves a driver via name when an unquoted space in the path defeats argv0', () => {
    // sysinfo hands us already-parsed, unquoted argv: the original quoting
    // around "John Smith" is gone by the time this reaches TypeScript, so
    // argv0Basename splits on the space and gets 'C:\Users\John' — no match.
    const r = resolveLabel(
      sample({
        pid: 60,
        command: 'C:\\Users\\John Smith\\bin\\claude.exe --print',
        name: 'claude.exe'
      }),
      undefined,
      sources()
    )
    expect(r).toEqual({
      kind: 'driver',
      label: 'Claude driver',
      provider: 'claude-agent-sdk',
      inferred: true
    })
  })

  it('resolves the graphify pack binary via name when an unquoted space in the path defeats argv0', () => {
    const r = resolveLabel(
      sample({
        pid: 61,
        command: 'C:\\Users\\John Smith\\packs\\code-graph\\bin\\graphify --repo .',
        name: 'graphify.exe'
      }),
      undefined,
      sources()
    )
    expect(r).toEqual({ kind: 'pack-binary', label: 'graphify', inferred: true })
  })

  it('lets a successful argv0 match win over a differently-matching name', () => {
    const r = resolveLabel(
      sample({
        pid: 62,
        command: '/usr/local/bin/claude --print',
        name: 'copilot.exe'
      }),
      undefined,
      sources()
    )
    expect(r).toEqual({
      kind: 'driver',
      label: 'Claude driver',
      provider: 'claude-agent-sdk',
      inferred: true
    })
  })

  it('returns null when neither argv0 nor name matches anything', () => {
    const r = resolveLabel(
      sample({
        pid: 63,
        command: '/usr/bin/node server.js',
        name: 'node'
      }),
      undefined,
      sources()
    )
    expect(r).toBeNull()
  })
})

describe('resolveLabel — MCP connector matching', () => {
  const github = {
    instanceId: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github']
  }

  it('matches a POSIX npx spawn', () => {
    const r = resolveLabel(
      sample({ pid: 50, command: 'npx -y @modelcontextprotocol/server-github' }),
      undefined,
      sources({ connectors: [github] })
    )
    expect(r).toEqual({
      kind: 'mcp',
      label: 'MCP: github',
      instanceId: 'github',
      inferred: true
    })
  })

  it('matches the Windows node/npx-cli rewrite, where argv0 is node.exe', () => {
    const r = resolveLabel(
      sample({
        pid: 51,
        command:
          'C:\\Program Files\\nodejs\\node.exe C:\\npm\\npx-cli.js -y @modelcontextprotocol/server-github'
      }),
      undefined,
      sources({ connectors: [github] })
    )
    expect(r?.instanceId).toBe('github')
  })

  it('matches case-insensitively', () => {
    const r = resolveLabel(
      sample({ pid: 52, command: 'NPX -Y @MODELCONTEXTPROTOCOL/SERVER-GITHUB' }),
      undefined,
      sources({ connectors: [github] })
    )
    expect(r?.instanceId).toBe('github')
  })

  it('does not match when one configured token is absent', () => {
    const r = resolveLabel(
      sample({ pid: 53, command: 'npx -y @modelcontextprotocol/server-gitlab' }),
      undefined,
      sources({ connectors: [github] })
    )
    expect(r).toBeNull()
  })

  it('refuses to match on generic tokens alone, so a bare npx connector claims nothing', () => {
    const bare = { instanceId: 'bare', command: 'npx', args: ['-y'] }
    const r = resolveLabel(
      sample({ pid: 54, command: 'npx -y @some/unrelated-package' }),
      undefined,
      sources({ connectors: [bare] })
    )
    expect(r).toBeNull()
  })

  it('prefers the connector with more distinctive matched tokens', () => {
    const broad = { instanceId: 'broad', command: 'npx', args: ['@scope/server'] }
    const exact = { instanceId: 'exact', command: 'npx', args: ['@scope/server', '--repo=argus'] }
    const r = resolveLabel(
      sample({ pid: 55, command: 'npx @scope/server --repo=argus' }),
      undefined,
      sources({ connectors: [broad, exact] })
    )
    expect(r?.instanceId).toBe('exact')
  })

  it('breaks a tie by instanceId so the label never flickers between ticks', () => {
    const b = { instanceId: 'bravo', command: 'npx', args: ['@scope/server'] }
    const a = { instanceId: 'alpha', command: 'npx', args: ['@scope/server'] }
    const r = resolveLabel(
      sample({ pid: 56, command: 'npx @scope/server' }),
      undefined,
      sources({ connectors: [b, a] })
    )
    expect(r?.instanceId).toBe('alpha')
  })

  it('ranks a driver basename above a connector match', () => {
    const sneaky = { instanceId: 'sneaky', command: 'claude', args: ['--print'] }
    const r = resolveLabel(
      sample({ pid: 57, command: '/usr/local/bin/claude --print' }),
      undefined,
      sources({ connectors: [sneaky] })
    )
    expect(r?.kind).toBe('driver')
  })
})

describe('stdioConnectorCommands', () => {
  it('keeps stdio instances and drops http ones and blank commands', () => {
    expect(
      stdioConnectorCommands({
        gh: { kind: 'stdio', config: { command: 'npx', args: ['-y', '@x/gh'] } },
        web: { kind: 'http', config: { url: 'https://example.test' } },
        blank: { kind: 'stdio', config: { command: '  ', args: [] } }
      } as never)
    ).toEqual([{ instanceId: 'gh', command: 'npx', args: ['-y', '@x/gh'] }])
  })
})

describe('resolveLabel — tier A (registry)', () => {
  const registered = (
    over: Record<string, RegisteredLabel> = {}
  ): ReadonlyMap<string, RegisteredLabel> => new Map(Object.entries(over))

  it('returns the registered label, marked authoritative', () => {
    const r = resolveLabel(
      sample({ pid: 70, startTimeMs: 1_000 }),
      undefined,
      sources({
        registered: registered({
          '70:1000': {
            kind: 'driver',
            label: 'Cursor driver',
            provider: 'cursor',
            owner: 'CASE-A:7'
          }
        })
      })
    )
    expect(r).toEqual({
      kind: 'driver',
      label: 'Cursor driver',
      provider: 'cursor',
      owner: 'CASE-A:7',
      inferred: false
    })
  })

  it('beats tier B', () => {
    const r = resolveLabel(
      sample({ pid: 71, startTimeMs: 1_000 }),
      metric({ pid: 71, type: 'Tab' }),
      sources({
        windows: [{ osPid: 71, kind: 'main-window' }],
        registered: registered({ '71:1000': { kind: 'driver', label: 'Codex driver' } })
      })
    )
    expect(r?.label).toBe('Codex driver')
  })

  it('beats tier C', () => {
    const r = resolveLabel(
      sample({ pid: 72, startTimeMs: 1_000, command: '/usr/local/bin/claude --print' }),
      undefined,
      sources({ registered: registered({ '72:1000': { kind: 'driver', label: 'Codex driver' } }) })
    )
    expect(r?.label).toBe('Codex driver')
    expect(r?.inferred).toBe(false)
  })

  it('does not match a registration for the same pid at a different start time', () => {
    const r = resolveLabel(
      sample({ pid: 73, startTimeMs: 2_000 }),
      undefined,
      sources({ registered: registered({ '73:1000': { kind: 'driver', label: 'Codex driver' } }) })
    )
    expect(r).toBeNull()
  })

  it('omits provider, instanceId and owner when the registration does not carry them', () => {
    const r = resolveLabel(
      sample({ pid: 74, startTimeMs: 1_000 }),
      undefined,
      sources({ registered: registered({ '74:1000': { kind: 'pack-binary', label: 'graphify' } }) })
    )
    expect('provider' in r!).toBe(false)
    expect('instanceId' in r!).toBe(false)
    expect('owner' in r!).toBe(false)
  })
})
