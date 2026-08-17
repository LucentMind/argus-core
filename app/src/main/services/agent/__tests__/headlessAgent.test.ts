import { describe, it, expect } from 'vitest'
import { settingsSchema, type AppSettings } from '../../../../shared/settings'
import { createHeadlessAgentRunner, type HeadlessAgentRunOpts } from '../headlessAgent'
import type { AgentDriver, HeadlessAgentOpts } from '../driver'

function stubDriver(record: { prompt?: string; opts?: HeadlessAgentOpts }): AgentDriver {
  return {
    kind: 'claude-agent-sdk',
    toolTaxonomy: {} as never,
    capabilities: {
      permissionModes: [],
      editableApprovals: true,
      costReporting: true,
      headlessOneShot: true,
      headlessAgent: true
    } as never,
    authFixHint: '',
    createSession: () => {
      throw new Error('not used')
    },
    probeAuth: async () => ({ ok: true, detail: '' }),
    runHeadlessAgent: async (prompt, opts) => {
      record.prompt = prompt
      record.opts = opts
      return { text: 'distilled', turnCount: 1, toolCallCount: 0, trajectory: [] }
    }
  }
}

const copilotActive = (extra: Record<string, unknown> = {}): AppSettings =>
  settingsSchema.parse({
    agent: {
      activeInstanceId: 'github-copilot-1',
      providerInstances: {
        'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} },
        'claude-agent-sdk-1': { driver: 'claude-agent-sdk', enabled: true, config: {} }
      },
      ...extra
    }
  })

const baseRunOpts: HeadlessAgentRunOpts = {
  mcpServer: { fake: 'mcp' },
  allowedTools: ['mcp__argus__read_transcript'],
  maxIterations: 12
}

describe('createHeadlessAgentRunner', () => {
  it('resolves the Claude instance and threads mcpServer/allowedTools/maxIterations through', async () => {
    const rec: { prompt?: string; opts?: HeadlessAgentOpts } = {}
    const run = createHeadlessAgentRunner({
      settings: copilotActive,
      argusHome: '/tmp/argus',
      driverForKind: () => stubDriver(rec)
    })
    const result = await run('the prompt', baseRunOpts)
    expect(result.text).toBe('distilled')
    expect(rec.prompt).toBe('the prompt')
    expect(rec.opts?.model?.startsWith('claude-')).toBe(true)
    expect(rec.opts?.argusHome).toBe('/tmp/argus')
    expect(rec.opts?.mcpServer).toBe(baseRunOpts.mcpServer)
    expect(rec.opts?.allowedTools).toBe(baseRunOpts.allowedTools)
    expect(rec.opts?.maxIterations).toBe(12)
  })

  it('forwards a configured batch timeout to the driver', async () => {
    const rec: { prompt?: string; opts?: HeadlessAgentOpts } = {}
    const run = createHeadlessAgentRunner({
      settings: copilotActive,
      argusHome: '/tmp/argus',
      timeoutMs: 600_000,
      driverForKind: () => stubDriver(rec)
    })
    await run('p', baseRunOpts)
    expect(rec.opts?.timeoutMs).toBe(600_000)
  })

  it('throws the resolver reason when nothing can run agent-based distillation', async () => {
    const settings = (): AppSettings =>
      settingsSchema.parse({
        agent: {
          activeInstanceId: 'github-copilot-1',
          providerInstances: {
            'github-copilot-1': { driver: 'github-copilot', enabled: true, config: {} }
          }
        }
      })
    const run = createHeadlessAgentRunner({ settings, argusHome: '/tmp/argus' })
    await expect(run('p', baseRunOpts)).rejects.toThrow(
      'no provider configured for agent-based distillation'
    )
  })

  it('rejects an explicit provider that lacks headlessAgent even though it supports headlessOneShot', async () => {
    const settings = (): AppSettings =>
      copilotActive({ distillProvider: { instanceId: 'github-copilot-1' } })
    const run = createHeadlessAgentRunner({ settings, argusHome: '/tmp/argus' })
    await expect(run('p', baseRunOpts)).rejects.toThrow(
      'provider "github-copilot-1" (github-copilot) cannot run agent-based distillation'
    )
  })

  it('throws when the resolved driver has no runHeadlessAgent', async () => {
    const noAgent = { ...stubDriver({}), runHeadlessAgent: undefined } as AgentDriver
    const run = createHeadlessAgentRunner({
      settings: copilotActive,
      argusHome: '/tmp/argus',
      driverForKind: () => noAgent
    })
    await expect(run('p', baseRunOpts)).rejects.toThrow(/cannot run agent-based distillation/)
  })

  it('forwards an abort signal to the driver', async () => {
    const rec: { prompt?: string; opts?: HeadlessAgentOpts } = {}
    const run = createHeadlessAgentRunner({
      settings: copilotActive,
      argusHome: '/tmp/argus',
      driverForKind: () => stubDriver(rec)
    })
    const ac = new AbortController()
    await run('prompt', { ...baseRunOpts, signal: ac.signal })
    expect(rec.opts?.signal).toBe(ac.signal)
  })

  it('omits the signal key when the caller passes none', async () => {
    const rec: { prompt?: string; opts?: HeadlessAgentOpts } = {}
    const run = createHeadlessAgentRunner({
      settings: copilotActive,
      argusHome: '/tmp/argus',
      driverForKind: () => stubDriver(rec)
    })
    await run('prompt', baseRunOpts)
    expect('signal' in rec.opts!).toBe(false)
  })
})
