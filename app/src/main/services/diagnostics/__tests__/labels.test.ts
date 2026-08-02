import { describe, it, expect } from 'vitest'
import { resolveLabel, type LabelSources, type WindowDescriptor } from '../labels'
import type { ElectronProcessMetric, ProcessSample } from '../../../../shared/diagnostics'

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
  return { windows: [], connectors: [], ...over }
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
