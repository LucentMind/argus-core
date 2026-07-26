import { describe, it, expect } from 'vitest'
import { assertDevTools } from '../ipcGate'

describe('assertDevTools', () => {
  it('passes through when the gate is on', () => {
    expect(() => assertDevTools(true)).not.toThrow()
  })

  it('throws when the gate is off', () => {
    // Renderer-side hiding is presentation only — the preload bridge is reachable from the
    // devtools console, so main must refuse rather than trust the UI.
    expect(() => assertDevTools(false)).toThrow(/dev tools are not enabled/i)
  })
})
