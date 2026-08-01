import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Electron's ipcRenderer.invoke rejects with a NEW plain Error reading
//   Error invoking remote method '<channel>': <stringified main error>
// so every one of the ~190 channels on the main bridge can leak IPC plumbing into user-facing
// text (38 renderer sites render a caught `.message` straight into the DOM). The wrapper is
// added in exactly one place, so it is removed in exactly one place: the preload's own
// invoke(). A per-call-site fix would leave every other channel leaking, which is why this is
// asserted structurally rather than channel by channel.
const SRC = path.resolve(__dirname, '../..')
const preload = fs.readFileSync(path.join(SRC, 'preload', 'index.ts'), 'utf8')

describe('the main preload scrubs the Electron IPC wrapper for every channel', () => {
  it('routes every channel through the wrapping invoke(), never ipcRenderer.invoke directly', () => {
    // The wrapper's own `ipcRenderer.invoke(channel, ...)` is the one legitimate raw call;
    // anything else — `ipcRenderer.invoke(IPC.x)` — is a channel bypassing the scrub.
    const raw = preload.match(/ipcRenderer\.invoke\([^)]*/g) ?? []
    const bypassing = raw.filter((call) => !call.startsWith('ipcRenderer.invoke(channel'))
    expect(bypassing).toEqual([])
    expect(raw).toHaveLength(1)
  })

  it('still exposes the bridge over a real set of channels (guards against a vacuous pass)', () => {
    expect((preload.match(/\binvoke\(IPC\./g) ?? []).length).toBeGreaterThan(150)
  })

  it('defines that invoke() in terms of ipcRenderer and the shared scrubber', () => {
    expect(preload).toMatch(/from '\.\.\/shared\/ipcError'/)
    expect(preload).toMatch(/cleanIpcErrorMessage/)
  })

  // The panel preload runs under sandbox:true as a single file. electron-vite emits a shared
  // chunk whenever BOTH preload entries import the same module, and a bundled relative
  // require() throws there — the same trap panelPreloadSelfContained.test.ts pins for
  // shared/ipc. So the scrubber stays out of the panel entry's import graph on purpose.
  it('keeps shared/ipcError out of the sandboxed panel preload', () => {
    const panel = fs.readFileSync(path.join(SRC, 'preload', 'panel.ts'), 'utf8')
    const sharedPanels = fs.readFileSync(path.join(SRC, 'shared', 'panels.ts'), 'utf8')
    expect(panel).not.toMatch(/ipcError/)
    expect(sharedPanels).not.toMatch(/ipcError/)
  })
})
