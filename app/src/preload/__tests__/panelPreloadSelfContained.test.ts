import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc'
import { PANEL_BRIDGE_CHANNELS } from '../../shared/panels'

// The panel preload runs under sandbox:true, where require() resolves only
// 'electron' and built-ins — a bundled relative ./chunks/* require throws on
// load, silently leaving window.argus and the theme unset. electron-vite emits
// a shared chunk whenever BOTH preload entries import the same module, so the
// panel preload's import graph (panel.ts + shared/panels' buildPanelApi) must
// NOT import ../shared/ipc (which the main preload also imports). The panel
// channel names live inline in shared/panels as PANEL_BRIDGE_CHANNELS instead.
const SRC = path.resolve(__dirname, '../..')

describe('panel preload stays self-contained (sandbox:true single-file)', () => {
  it('neither panel.ts nor shared/panels.ts imports ./ipc', () => {
    const panel = fs.readFileSync(path.join(SRC, 'preload', 'panel.ts'), 'utf8')
    const shared = fs.readFileSync(path.join(SRC, 'shared', 'panels.ts'), 'utf8')
    expect(panel).not.toMatch(/from ['"][^'"]*\/ipc['"]/)
    expect(shared).not.toMatch(/from ['"]\.\/ipc['"]/)
  })

  it('PANEL_BRIDGE_CHANNELS stays in sync with the IPC registry', () => {
    expect(PANEL_BRIDGE_CHANNELS).toEqual({
      getCaseContext: IPC.panelsGetCaseContext,
      requestEvidence: IPC.panelsRequestEvidence,
      readEvidence: IPC.panelsReadEvidence,
      theme: IPC.panelsTheme
    })
  })
})
