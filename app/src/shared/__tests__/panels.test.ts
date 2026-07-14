import { describe, it, expect, vi } from 'vitest'
import { buildPanelApi } from '../panels'
import { panelThemeVars } from '../panelTheme'
import { IPC } from '../ipc'

describe('buildPanelApi', () => {
  it('includes only granted verbs', () => {
    const api = buildPanelApi(['readEvidence'], vi.fn(async () => undefined))
    expect(typeof api.readEvidence).toBe('function')
    expect(api.getCaseContext).toBeUndefined()
    expect(api.requestEvidence).toBeUndefined()
  })

  it('wires each verb to its channel with the right args', async () => {
    const invoke = vi.fn(async () => 'ok')
    const api = buildPanelApi(['getCaseContext', 'requestEvidence', 'readEvidence'], invoke) as {
      getCaseContext: () => Promise<unknown>
      requestEvidence: (q: string) => Promise<unknown>
      readEvidence: (id: number, line?: number) => Promise<unknown>
    }
    await api.getCaseContext()
    await api.requestEvidence('foo')
    await api.readEvidence(5, 12)
    expect(invoke).toHaveBeenCalledWith(IPC.panelsGetCaseContext)
    expect(invoke).toHaveBeenCalledWith(IPC.panelsRequestEvidence, 'foo')
    expect(invoke).toHaveBeenCalledWith(IPC.panelsReadEvidence, 5, 12)
  })

  it('exposes listCaseEvidence when granted and wires it to its channel', async () => {
    const invoke = vi.fn(async () => [])
    const api = buildPanelApi(['listCaseEvidence'], invoke) as {
      listCaseEvidence: () => Promise<unknown>
    }
    expect(typeof api.listCaseEvidence).toBe('function')
    await api.listCaseEvidence()
    expect(invoke).toHaveBeenCalledWith(IPC.panelsListCaseEvidence)
  })
})

describe('panelThemeVars', () => {
  it('returns the public --argus-* contract for each theme', () => {
    const dark = panelThemeVars('dark')
    const light = panelThemeVars('light')
    expect(dark['--argus-bg']).toBe('#0a0a0b')
    expect(dark['--argus-text']).toBe('#efede6')
    expect(light['--argus-bg']).toBe('#faf8f3')
    expect(light['--argus-text']).toBe('#18181b')
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort())
    expect(Object.keys(dark)).toContain('--argus-accent')
  })
})

import { panelKeyStr, panelHandlesType, type PanelDecl } from '../panels'

describe('panelKeyStr', () => {
  it('joins the identity triple stably', () => {
    expect(panelKeyStr({ caseSlug: 'CASE-A', packId: 'sample-pack', windowId: 'text-viewer' })).toBe(
      'CASE-A::sample-pack::text-viewer'
    )
  })
})

describe('panelHandlesType', () => {
  const decls: PanelDecl[] = [
    { packId: 'sample-pack', windowId: 'text-viewer', title: 'Text Viewer', handles: ['logcat', 'dlt-text'], kind: 'webPanel' },
    { packId: 'p2', windowId: 'w2', title: 'Other', handles: ['pcap'], kind: 'webPanel' },
    { packId: 'p3', windowId: 'w3', title: 'Launcher only', handles: [], kind: 'webPanel' }
  ]
  it('returns every decl whose handles include the type', () => {
    expect(panelHandlesType(decls, 'logcat').map((d) => d.windowId)).toEqual(['text-viewer'])
    expect(panelHandlesType(decls, 'pcap').map((d) => d.windowId)).toEqual(['w2'])
  })
  it('returns [] for an unhandled or empty type', () => {
    expect(panelHandlesType(decls, 'binlog')).toEqual([])
    expect(panelHandlesType(decls, '')).toEqual([])
  })
})
