// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ContextGauge } from '../ContextGauge'
import { GAUGE_TUNING, type GaugeFrame, type GaugeRenderer } from '../../lib/contextGaugeGL'

/** A renderer that reports itself usable and records every frame it is handed. */
function fakeGL(available = true): GaugeRenderer & { frames: GaugeFrame[] } {
  const frames: GaugeFrame[] = []
  return { available: () => available, render: (_c, f) => frames.push(f), frames }
}

const TONE = 'rgb(139, 220, 165)'

function mount(ui: React.ReactNode): ReturnType<typeof render> {
  // The gauge reads its colour off `currentColor`, exactly as the CSS rendering does. jsdom
  // applies no stylesheet, so the tone has to come from an inline style on an ancestor.
  return render(<div style={{ color: TONE }}>{ui}</div>)
}

/** Let jsdom's rAF fire n times. */
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
  }
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia
})

describe('ContextGauge rendering choice', () => {
  it('paints the clean CSS edge in the classic theme even when WebGL is available', async () => {
    // The whole point of the classic theme here: no ridge, no canvas, no GPU. Availability must
    // not be enough to opt a classic-theme user into the wave.
    const gl = fakeGL(true)
    mount(<ContextGauge pct={42} dynamic={false} toneKey="review" light={false} renderer={gl} />)
    const el = screen.getByTestId('context-gauge')
    expect(el.dataset.mode).toBe('flat')
    expect(el.tagName).toBe('SPAN')
    expect(el.style.width).toBe('42%')
    expect(el.className).toContain('ctx-gauge')
    await frames(2)
    expect(gl.frames).toHaveLength(0)
  })

  it('paints the ridge in the dynamic theme', async () => {
    const gl = fakeGL(true)
    mount(<ContextGauge pct={42} dynamic={true} toneKey="review" light={false} renderer={gl} />)
    const el = screen.getByTestId('context-gauge')
    expect(el.dataset.mode).toBe('wave')
    expect(el.tagName).toBe('CANVAS')
    // Full width, not 42% — the filament blooms past its own crest and a percentage-width
    // element would shear the bloom off at the one edge that matters.
    expect(el.getAttribute('style')).toBeNull()
    // A canvas is a REPLACED element: `inset-0` alone leaves it at its intrinsic 300x150,
    // clipped to the pill, and every reading lands at a third of where it belongs. That shipped.
    // jsdom does no layout so this cannot be measured here — asserting the classes is a proxy
    // for the Chromium measurement (300x150 without them, 108x18 with) that actually found it.
    expect(el.className).toContain('inset-0')
    expect(el.className).toContain('h-full')
    expect(el.className).toContain('w-full')
    await frames(1)
    expect(gl.frames[0]).toMatchObject({ fill: 0.42, ...GAUGE_TUNING })
    expect(gl.frames[0].tone).toEqual([139 / 255, 220 / 255, 165 / 255])
  })

  it('falls back to the clean edge when WebGL2 is unavailable', async () => {
    // The real path for jsdom, a lost GPU process, and a blocklisted driver. A dynamic-theme
    // user gets the classic gauge, never an empty pill.
    const gl = fakeGL(false)
    mount(<ContextGauge pct={42} dynamic={true} toneKey="review" light={false} renderer={gl} />)
    const el = screen.getByTestId('context-gauge')
    expect(el.dataset.mode).toBe('flat')
    expect(el.style.width).toBe('42%')
    await frames(2)
    expect(gl.frames).toHaveLength(0)
  })
})

describe('ContextGauge motion', () => {
  it('advances time frame over frame', async () => {
    const gl = fakeGL()
    mount(<ContextGauge pct={60} dynamic={true} toneKey="review" light={false} renderer={gl} />)
    await frames(3)
    expect(gl.frames.length).toBeGreaterThan(1)
    expect(gl.frames[gl.frames.length - 1].t).toBeGreaterThan(gl.frames[0].t)
  })

  it('draws one still frame and schedules nothing more under reduced motion', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never
    const gl = fakeGL()
    mount(<ContextGauge pct={60} dynamic={true} toneKey="review" light={false} renderer={gl} />)
    await frames(4)
    // The shape survives, the drift does not — that is the trade, not a fallback to the flat
    // bar. One frame, then the loop stops for good.
    expect(gl.frames).toHaveLength(1)
    expect(gl.frames[0].fill).toBe(0.6)
  })

  it('does not restart the drift when the reading changes', async () => {
    // A turn emits context.usage several times. If `pct` were a dependency of the animation
    // effect, each one would tear the loop down and snap the ridge back to its frozen phase.
    const gl = fakeGL()
    const { rerender } = mount(
      <ContextGauge pct={30} dynamic={true} toneKey="review" light={false} renderer={gl} />
    )
    await frames(2)
    const before = gl.frames.length
    rerender(
      <div style={{ color: TONE }}>
        <ContextGauge pct={70} dynamic={true} toneKey="review" light={false} renderer={gl} />
      </div>
    )
    await frames(2)
    const after = gl.frames.slice(before)
    expect(after.length).toBeGreaterThan(0)
    expect(after[0].fill).toBe(0.7) // picked the new reading up…
    expect(after[0].t).toBeGreaterThan(gl.frames[before - 1].t) // …without rewinding the clock
  })

  it('redraws the still frame when the reading changes under reduced motion', async () => {
    // With no loop running, the effect keyed on pct is the ONLY thing that will show a new
    // reading. Without it the gauge would freeze at whatever it first drew.
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never
    const gl = fakeGL()
    const { rerender } = mount(
      <ContextGauge pct={30} dynamic={true} toneKey="review" light={false} renderer={gl} />
    )
    await frames(1)
    expect(gl.frames.map((f) => f.fill)).toEqual([0.3])
    rerender(
      <div style={{ color: TONE }}>
        <ContextGauge pct={70} dynamic={true} toneKey="review" light={false} renderer={gl} />
      </div>
    )
    await frames(1)
    expect(gl.frames.map((f) => f.fill)).toEqual([0.3, 0.7])
    expect(gl.frames.every((f) => f.t === gl.frames[0].t)).toBe(true)
  })

  it('repaints when the status tone changes, even with the reading unmoved', async () => {
    // Seen live: a session went agent-✗ → ready, the pill turned green, and the canvas stayed
    // RED underneath it. With motion off nothing re-reads currentColor unless a dependency
    // changes, and the reading had not moved.
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never
    const gl = fakeGL()
    const { rerender } = render(
      <div style={{ color: 'rgb(242, 122, 107)' }}>
        <ContextGauge pct={40} dynamic={true} toneKey="danger" light={false} renderer={gl} />
      </div>
    )
    await frames(1)
    expect(gl.frames).toHaveLength(1)
    expect(gl.frames[0].tone).toEqual([242 / 255, 122 / 255, 107 / 255])

    rerender(
      <div style={{ color: TONE }}>
        <ContextGauge pct={40} dynamic={true} toneKey="review" light={false} renderer={gl} />
      </div>
    )
    await frames(1)
    expect(gl.frames).toHaveLength(2)
    expect(gl.frames[1].tone).toEqual([139 / 255, 220 / 255, 165 / 255])
  })

  it('repaints when the theme flips', async () => {
    // Light is a different branch in the shader, so a theme switch under reduced motion would
    // otherwise leave the dark rendering frozen on a light ground.
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never
    const gl = fakeGL()
    const { rerender } = mount(
      <ContextGauge pct={40} dynamic={true} toneKey="review" light={false} renderer={gl} />
    )
    await frames(1)
    rerender(
      <div style={{ color: TONE }}>
        <ContextGauge pct={40} dynamic={true} toneKey="review" light={true} renderer={gl} />
      </div>
    )
    await frames(1)
    expect(gl.frames.map((f) => f.light)).toEqual([false, true])
  })

  it('stops rendering after unmount', async () => {
    const gl = fakeGL()
    const { unmount } = mount(
      <ContextGauge pct={60} dynamic={true} toneKey="review" light={false} renderer={gl} />
    )
    await frames(2)
    const seen = gl.frames.length
    unmount()
    await frames(3)
    expect(gl.frames).toHaveLength(seen)
  })
})
