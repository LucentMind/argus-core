import { describe, it, expect } from 'vitest'
import { registerProbe } from '../mcp'
import { ProcessLabels } from '../diagnostics/processLabels'

describe('registerProbe', () => {
  it('registers a stdio probe pid with the tier-A mcp label', () => {
    const labels = new ProcessLabels()
    registerProbe(labels, 'github', 4242, 1_000)
    expect(
      labels
        .reconcile(
          [
            {
              pid: 4242,
              ppid: 1,
              startTimeMs: 1_000,
              runTimeMs: 0,
              name: 'proc-4242',
              command: '/bin/proc-4242',
              status: 'Run',
              cpuTimeMs: 0,
              residentBytes: 0
            }
          ],
          1_100
        )
        .get('4242:1000')
    ).toEqual({ kind: 'mcp', label: 'MCP probe: github', instanceId: 'github' })
  })

  it('is a no-op when no registry is injected', () => {
    // undefined labels is the production default before index.ts wires the singleton in
    expect(() => registerProbe(undefined, 'github', 4242, 1_000)).not.toThrow()
  })
})
