// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useEffect, useState } from 'react'
import { DynamicScope } from '../DynamicScope'
import { uiStore } from '../../lib/uiStore'
import { useAmbientAnchors } from '../../lib/ambientAnchors'

beforeEach(() => {
  localStorage.clear()
  uiStore.setDynamicTheme(false)
  uiStore.setTheme('dark')
})

/** Counts its own mounts so the remount assertion below is about mounting,
 *  not about re-rendering. */
function MountCounter(): React.JSX.Element {
  const [id] = useState(() => ++MountCounter.mounts)
  return <span data-testid="counter">{id}</span>
}
MountCounter.mounts = 0

function Anchored(): React.JSX.Element {
  const anchors = useAmbientAnchors()
  const [seen, setSeen] = useState('')
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeen(typeof anchors.setLight === 'function' ? 'wired' : 'missing')
  }, [anchors])
  return <span data-testid="anchors">{seen}</span>
}

describe('DynamicScope — case variant', () => {
  it('off: wrapper still renders, but with no scope class and no band', () => {
    render(
      <DynamicScope variant="case">
        <span>inner</span>
      </DynamicScope>
    )
    const root = screen.getByTestId('dynamic-case')
    expect(root.className).not.toContain('dyn-case')
    expect(screen.queryByTestId('ambient-fallback')).toBeNull()
    expect(screen.getByText('inner')).toBeTruthy()
  })

  it('on: scope class and band mount', () => {
    uiStore.setDynamicTheme(true)
    render(
      <DynamicScope variant="case">
        <span>inner</span>
      </DynamicScope>
    )
    const root = screen.getByTestId('dynamic-case')
    expect(root.className).toContain('dyn ')
    expect(root.className).toContain('dyn-case')
    expect(screen.getByTestId('ambient-fallback')).toBeTruthy()
  })

  it('carries the flex chain so the panes keep their height basis', () => {
    uiStore.setDynamicTheme(true)
    render(
      <DynamicScope variant="case">
        <span>inner</span>
      </DynamicScope>
    )
    const cls = screen.getByTestId('dynamic-case').className
    for (const c of ['flex', 'min-h-0', 'flex-1', 'flex-col']) expect(cls).toContain(c)
  })

  it('toggling does NOT remount the children', () => {
    MountCounter.mounts = 0
    render(
      <DynamicScope variant="case">
        <MountCounter />
      </DynamicScope>
    )
    expect(screen.getByTestId('counter').textContent).toBe('1')
    act(() => uiStore.setDynamicTheme(true))
    expect(screen.getByTestId('counter').textContent).toBe('1')
    act(() => uiStore.setDynamicTheme(false))
    expect(screen.getByTestId('counter').textContent).toBe('1')
  })

  it('provides anchors to children', () => {
    uiStore.setDynamicTheme(true)
    render(
      <DynamicScope variant="case">
        <Anchored />
      </DynamicScope>
    )
    expect(screen.getByTestId('anchors').textContent).toBe('wired')
  })

  it('paints no grain at all — grain is home-only', () => {
    uiStore.setDynamicTheme(true)
    render(
      <DynamicScope variant="case">
        <span>inner</span>
      </DynamicScope>
    )
    expect(document.querySelector('.dyn-grain')).toBeNull()
  })
})
