// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DynamicScope } from '../DynamicScope'
import type { AmbientCanvas as AmbientCanvasType } from '../AmbientCanvas'
import { uiStore } from '../../lib/uiStore'

/**
 * A thin pass-through wrapper, not a behaviour change: every call delegates straight to the real
 * `AmbientCanvas`, so every test below except the one that reads `lastAmbientCanvasProps` is
 * exercising the genuine fallback/grain/scope-class behaviour. The capture is what lets the
 * anchor-forwarding test below assert DynamicScope passed the exact `light`/`cutoff` elements it
 * was given, rather than merely that *something* rendered — the DOM has no other way to observe
 * this, because the jsdom WebGL fallback path is static CSS and ignores both props entirely.
 */
let lastAmbientCanvasProps: Parameters<typeof AmbientCanvasType>[0] | null = null
vi.mock('../AmbientCanvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../AmbientCanvas')>()
  return {
    ...actual,
    AmbientCanvas: (props: Parameters<typeof AmbientCanvasType>[0]) => {
      lastAmbientCanvasProps = props
      return <actual.AmbientCanvas {...props} />
    }
  }
})

beforeEach(() => {
  localStorage.clear()
  uiStore.setDynamicTheme(false)
  uiStore.setTheme('dark')
  lastAmbientCanvasProps = null
})

describe('DynamicScope — home variant', () => {
  it('off (default): children render with no wrapper, no canvas, no grain', () => {
    render(
      <DynamicScope variant="home" light={null} cutoff={null}>
        <span>inner</span>
      </DynamicScope>
    )
    expect(screen.getByText('inner')).toBeTruthy()
    expect(screen.queryByTestId('dynamic-home')).toBeNull()
    expect(screen.queryByTestId('ambient-fallback')).toBeNull()
    expect(screen.queryByTestId('ambient-canvas')).toBeNull()
  })

  it('on: token scope + variant class, ambient layer (jsdom fallback), grain', () => {
    uiStore.setDynamicTheme(true)
    render(
      <DynamicScope variant="home" light={null} cutoff={null}>
        <span>inner</span>
      </DynamicScope>
    )
    const root = screen.getByTestId('dynamic-home')
    expect(root.className).toContain('dyn ')
    expect(root.className).toContain('dyn-home')
    expect(root.className).toContain('bg-void')
    expect(screen.getByTestId('ambient-fallback')).toBeTruthy()
    expect(document.querySelector('.dyn-grain')).not.toBeNull()
  })

  it('reacts live to the store toggling', () => {
    render(
      <DynamicScope variant="home" light={null} cutoff={null}>
        <span>inner</span>
      </DynamicScope>
    )
    expect(screen.queryByTestId('dynamic-home')).toBeNull()
    act(() => uiStore.setDynamicTheme(true))
    expect(screen.getByTestId('dynamic-home')).toBeTruthy()
    act(() => uiStore.setDynamicTheme(false))
    expect(screen.queryByTestId('dynamic-home')).toBeNull()
  })
})

describe('DynamicScope — settings variant', () => {
  it('takes its anchors as props and forwards them to AmbientCanvas verbatim — App owns them, because TopBar needs them too', () => {
    uiStore.setDynamicTheme(true)
    const light = document.createElement('h1')
    const cutoff = document.createElement('div')
    render(
      <DynamicScope variant="settings" light={light} cutoff={cutoff}>
        <p>body</p>
      </DynamicScope>
    )
    expect(screen.getByTestId('dynamic-settings')).toBeInTheDocument()
    // The real assertion: these are the exact elements DynamicScope was given, not some default
    // or a stale value from a previous render. A DynamicScope that dropped the props on the floor
    // and passed `null`/`null` through would still satisfy every assertion above.
    expect(lastAmbientCanvasProps?.light).toBe(light)
    expect(lastAmbientCanvasProps?.cutoff).toBe(cutoff)
  })
})
