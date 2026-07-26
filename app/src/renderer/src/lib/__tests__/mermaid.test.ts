// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock factories are hoisted above const declarations — vi.hoisted keeps the
// mock fns referencable from both the factory and the assertions below.
const { renderMock, initializeMock } = vi.hoisted(() => ({
  renderMock: vi.fn(async (_id: string, _src: string) => ({ svg: '<svg>ok</svg>' })),
  initializeMock: vi.fn()
}))
vi.mock('mermaid', () => ({
  default: { initialize: initializeMock, render: renderMock }
}))

import { renderMermaid } from '../mermaid'

beforeEach(() => {
  renderMock.mockClear()
  initializeMock.mockClear()
})

describe('renderMermaid', () => {
  it('returns the rendered svg on success', async () => {
    const out = await renderMermaid('flowchart TD\n A-->B')
    expect(out).toEqual({ ok: true, svg: '<svg>ok</svg>' })
  })

  it('initializes with strict security and html labels off, every render', async () => {
    await renderMermaid('flowchart TD\n A-->B')
    await renderMermaid('flowchart TD\n B-->C')
    expect(initializeMock).toHaveBeenCalledTimes(2)
    const cfg = initializeMock.mock.calls[0][0]
    expect(cfg.securityLevel).toBe('strict')
    expect(cfg.startOnLoad).toBe(false)
    expect(cfg.flowchart).toEqual({ htmlLabels: false })
    expect(cfg.theme).toBe('base')
    expect(cfg.themeVariables).toBeTruthy()
  })

  it('uses a fresh element id per render', async () => {
    await renderMermaid('a')
    await renderMermaid('b')
    const ids = renderMock.mock.calls.map((c) => c[0])
    expect(ids[0]).not.toBe(ids[1])
  })

  it('maps a render rejection to { ok: false } instead of throwing', async () => {
    renderMock.mockRejectedValueOnce(new Error('Parse error'))
    await expect(renderMermaid('not mermaid')).resolves.toEqual({ ok: false })
  })
})
