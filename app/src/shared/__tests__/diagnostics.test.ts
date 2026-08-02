import { describe, it, expect } from 'vitest'
import { parseSidecarEvent, DIAGNOSTICS_PROTOCOL_VERSION } from '../diagnostics'

const snapshotLine = JSON.stringify({
  version: 1,
  type: 'snapshot',
  sequence: 3,
  sampledAtUnixMs: 1_700_000_000_000,
  collectionDurationMicros: 4200,
  scannedProcessCount: 414,
  retainedProcessCount: 7,
  processes: []
})

describe('parseSidecarEvent', () => {
  it('parses a well-formed snapshot', () => {
    const ev = parseSidecarEvent(snapshotLine)
    expect(ev?.type).toBe('snapshot')
    expect(ev && ev.type === 'snapshot' ? ev.retainedProcessCount : -1).toBe(7)
  })

  it('parses a hello', () => {
    const ev = parseSidecarEvent(
      JSON.stringify({ version: 1, type: 'hello', sidecarVersion: '0.1.0', pid: 4242 })
    )
    expect(ev).toEqual({ version: 1, type: 'hello', sidecarVersion: '0.1.0', pid: 4242 })
  })

  it('rejects a version mismatch rather than guessing', () => {
    expect(
      parseSidecarEvent(JSON.stringify({ version: 99, type: 'hello', sidecarVersion: 'x', pid: 1 }))
    ).toBeNull()
  })

  it('rejects malformed JSON without throwing', () => {
    expect(parseSidecarEvent('{not json')).toBeNull()
  })

  it('rejects an unknown event type', () => {
    expect(parseSidecarEvent(JSON.stringify({ version: 1, type: 'wat' }))).toBeNull()
  })

  it('rejects a blank line', () => {
    expect(parseSidecarEvent('   ')).toBeNull()
  })

  it('pins the protocol version', () => {
    expect(DIAGNOSTICS_PROTOCOL_VERSION).toBe(1)
  })
})
