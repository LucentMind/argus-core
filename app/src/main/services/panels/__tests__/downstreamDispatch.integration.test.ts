import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { loadPacks } from '../../packs/loader'
import { PackRegistry } from '../../packs/registry'
import { seededPacksDir } from '../../packs/paths'
import { PanelHost, type PanelViewFactory } from '../panelHost'
import { makeFakePanelViewFactory } from './fixtures'
import {
  flattenPanelCommands,
  panelToolName,
  buildPanelCommandTools
} from '../../agent/panelCommands'

// panels/__tests__ → up 5 = app/ (seededPacksDir → <repo>/packs).
const packsSrc = seededPacksDir(path.resolve(__dirname, '../../../../..'))

// A fake factory whose sendCommand replies immediately via host.resolveCommand.
function replyingFactory(reply: (cmd: string, args: unknown[]) => unknown): {
  factory: PanelViewFactory
  bind: (h: PanelHost) => void
} {
  let host: PanelHost | null = null
  const { factory } = makeFakePanelViewFactory({
    webContentsId: 601,
    sendCommand(requestId, cmd, args) {
      host!.resolveCommand(requestId, { ok: true, result: reply(cmd, args) })
    }
  })
  return {
    factory,
    bind: (h) => {
      host = h
    }
  }
}

describe('downstream dispatch — playground commands end to end', () => {
  it('registry declares the two playground commands with the right tool names', () => {
    const { packs, errors } = loadPacks(packsSrc)
    expect(errors).toEqual([])
    const decls = flattenPanelCommands(new PackRegistry(packs).windowDecls())
    const pg = decls.filter((d) => d.packId === 'sample-bridge-playground')
    expect(pg.map((d) => d.cmd)).toEqual(['highlight', 'echo'])
    expect(panelToolName(pg[0])).toBe('mcp__sample-bridge-playground__playground_highlight')
  })

  it('dispatchToPanel routes to an open panel and back; closed → structured error', async () => {
    const { factory, bind } = replyingFactory((cmd, args) => ({ echoed: [cmd, args] }))
    const host = new PanelHost({ db: {} as never, argusHome: '/x', factory })
    bind(host)
    host.open({
      caseSlug: 'CASE-A',
      packId: 'sample-bridge-playground',
      windowId: 'playground',
      title: 'PG',
      entry: 'playground/index.html',
      uiDir: '/ui',
      network: [],
      permissions: [],
      sessionId: 1
    })
    const open = await host.dispatchToPanel(
      { caseSlug: 'CASE-A', packId: 'sample-bridge-playground', windowId: 'playground' },
      'highlight',
      [4]
    )
    expect(open).toEqual({ ok: true, result: { echoed: ['highlight', [4]] } })
    const closed = await host.dispatchToPanel(
      { caseSlug: 'CASE-A', packId: 'sample-bridge-playground', windowId: 'nope' },
      'x',
      []
    )
    expect(closed).toMatchObject({ ok: false, reason: 'panel-not-open' })
  })

  it('the command tool handler dispatches and returns the panel result', async () => {
    const { packs } = loadPacks(packsSrc)
    const decls = flattenPanelCommands(new PackRegistry(packs).windowDecls()).filter(
      (d) => d.packId === 'sample-bridge-playground'
    )
    const tools = buildPanelCommandTools(decls, async (_p, _w, cmd, args) => ({ ran: cmd, args }))
    const highlight = tools.find((t) => t.name === 'playground_highlight')!
    const out = JSON.parse((await highlight.handler({ line: '7' })).content[0].text)
    expect(out).toEqual({ ran: 'highlight', args: ['7'] })
  })
})
