import { it, expect } from 'vitest'
import { buildPanelApi, PANEL_BRIDGE_CHANNELS } from '../panels'

it('exposes granted write verbs and omits ungranted ones', () => {
  const seen: string[] = []
  const api = buildPanelApi(['cite', 'sendToAgent'], async (ch) => {
    seen.push(ch)
    return undefined
  })
  expect(typeof api.cite).toBe('function')
  expect(typeof api.sendToAgent).toBe('function')
  expect(api.emitFinding).toBeUndefined()
  ;(api.cite as (r: string, l: number) => Promise<unknown>)('evidence/x', 3)
  expect(seen).toContain(PANEL_BRIDGE_CHANNELS.cite)
})

it('exposes ingestEvidence when granted', () => {
  const seen: string[] = []
  const api = buildPanelApi(['ingestEvidence'], async (ch) => {
    seen.push(ch)
    return undefined
  })
  expect(typeof api.ingestEvidence).toBe('function')
  ;(api.ingestEvidence as (i: unknown) => Promise<unknown>)({
    source: { bytes: new Uint8Array([1]) },
    filename: 'a.bin'
  })
  expect(seen).toContain(PANEL_BRIDGE_CHANNELS.ingestEvidence)
})
