import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPanelApi } from '../panels'
import { panelThemeVars, PANEL_TOKENS, type PanelTokenName } from '../panelTheme'
import { IPC } from '../ipc'

describe('buildPanelApi', () => {
  it('includes only granted verbs', () => {
    const api = buildPanelApi(
      ['readEvidence'],
      vi.fn(async () => undefined)
    )
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
    expect(light['--argus-bg']).toBe('#eef2f9')
    expect(light['--argus-text']).toBe('#101823')
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort())
    expect(Object.keys(dark)).toContain('--argus-accent')
  })

  /**
   * panelTheme.ts's DARK/LIGHT maps are hand-copies of the renderer's theme.css (the panel
   * preload cannot read the renderer's stylesheet), and the LIGHT copy silently drifted: the
   * light redesign moved theme.css to the cool `#eef2f9` wash while this copy kept the old
   * warm-paper `#faf8f3` / `#f0eee7` / `#18181b` / `#1567b3`, so a docked pack panel rendered on
   * warm paper inside a cool-blue app, in light mode only. Nothing caught it — the assertions
   * above compared the copy against itself, and themeTokens.test.ts's dead-literal scan (which
   * names those exact values) only ever reads theme.css. Same class of drift, same fix as
   * titleBar.test.ts's "mirrors theme.css" guard: read the stylesheet the copy claims to mirror
   * and hold the two together.
   *
   * The `--argus-*` NAMES stay the frozen public contract for third-party panels; only the values
   * track theme.css, which is what a theme change is.
   */
  it('mirrors theme.css — the copy panelTheme.ts admits it is', () => {
    const css = readFileSync(join(__dirname, '../../renderer/src/assets/theme.css'), 'utf8')
    /** The value of `name` inside the first `selector { … }` block. */
    const tokenIn = (selector: string, name: string): string => {
      const open = css.indexOf('{', css.indexOf(selector))
      const body = css.slice(open + 1, css.indexOf('}', open))
      const hit = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(body)
      if (!hit) throw new Error(`${name} not found in ${selector}`)
      return hit[1].trim()
    }

    /** Which theme.css token each public panel token is a copy of. */
    const SOURCE: Record<PanelTokenName, string> = {
      bg: '--bg-1',
      surface: '--bg-2',
      'surface-2': '--bg-hi',
      text: '--ink',
      dim: '--dim',
      faint: '--faint',
      hair: '--hair',
      accent: '--signal',
      danger: '--danger'
    }

    for (const [theme, selector] of [
      ['dark', ':root {'],
      ['light', ":root[data-theme='light'] {"]
    ] as const) {
      const vars = panelThemeVars(theme)
      for (const token of PANEL_TOKENS) {
        expect(vars[`--argus-${token}`], `${theme} --argus-${token} (${SOURCE[token]})`).toBe(
          tokenIn(selector, SOURCE[token])
        )
      }
    }
  })
})

import { panelKeyStr, panelHandlesType, type PanelDecl } from '../panels'

describe('panelKeyStr', () => {
  it('joins the identity triple stably', () => {
    expect(
      panelKeyStr({ caseSlug: 'CASE-A', packId: 'sample-pack', windowId: 'text-viewer' })
    ).toBe('CASE-A::sample-pack::text-viewer')
  })
})

describe('panelHandlesType', () => {
  const decls: PanelDecl[] = [
    {
      packId: 'sample-pack',
      windowId: 'text-viewer',
      title: 'Text Viewer',
      handles: ['logcat', 'dlt-text'],
      kind: 'webPanel'
    },
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
