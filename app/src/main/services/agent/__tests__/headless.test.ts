import { describe, it, expect } from 'vitest'
import { settingsSchema, type AppSettings } from '../../../../shared/settings'
import { createHeadlessRunner } from '../headless'
import type { AgentDriver, HeadlessOpts } from '../driver'

function stubDriver(record: { prompt?: string; opts?: HeadlessOpts }): AgentDriver {
  return {
    kind: 'claude-agent-sdk',
    toolTaxonomy: {} as never,
    capabilities: {
      permissionModes: [],
      editableApprovals: true,
      costReporting: true,
      headlessOneShot: true
    } as never,
    authFixHint: '',
    createSession: () => {
      throw new Error('not used')
    },
    probeAuth: async () => ({ ok: true, detail: '' }),
    runHeadless: async (prompt, opts) => {
      record.prompt = prompt
      record.opts = opts
      return 'distilled'
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

describe('createHeadlessRunner', () => {
  it('REGRESSION: runs on the Claude instance with a claude model while Copilot is active', async () => {
    const rec: { prompt?: string; opts?: HeadlessOpts } = {}
    const run = createHeadlessRunner({
      settings: copilotActive,
      argusHome: '/tmp/argus',
      driverForKind: () => stubDriver(rec)
    })
    expect(await run('the prompt')).toBe('distilled')
    expect(rec.prompt).toBe('the prompt')
    expect(rec.opts?.model).not.toBe('auto')
    expect(rec.opts?.model?.startsWith('claude-')).toBe(true)
    expect(rec.opts?.argusHome).toBe('/tmp/argus')
  })

  it('throws the resolver reason when nothing can distill', async () => {
    const settings = (): AppSettings =>
      settingsSchema.parse({
        agent: {
          activeInstanceId: 'github-copilot-1',
          providerInstances: {
            'github-copilot-1': { driver: 'github-copilot', enabled: false, config: {} }
          }
        }
      })
    const run = createHeadlessRunner({ settings, argusHome: '/tmp/argus' })
    await expect(run('p')).rejects.toThrow('no provider configured for distillation')
  })

  it('throws when the resolved driver has no runHeadless', async () => {
    const noHeadless = { ...stubDriver({}), runHeadless: undefined } as AgentDriver
    const run = createHeadlessRunner({
      settings: copilotActive,
      argusHome: '/tmp/argus',
      driverForKind: () => noHeadless
    })
    await expect(run('p')).rejects.toThrow(/cannot run headless distillation/)
  })

  it('re-reads settings on every call', async () => {
    const rec: { prompt?: string; opts?: HeadlessOpts } = {}
    let model = 'claude-sonnet-5'
    const run = createHeadlessRunner({
      settings: () =>
        copilotActive({ distillProvider: { instanceId: 'claude-agent-sdk-1', model } }),
      argusHome: '/tmp/argus',
      driverForKind: () => stubDriver(rec)
    })
    await run('a')
    expect(rec.opts?.model).toBe('claude-sonnet-5')
    model = 'claude-haiku-4-5'
    await run('b')
    expect(rec.opts?.model).toBe('claude-haiku-4-5')
  })
})
