// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { DynamicScope } from '../DynamicScope'
import { uiStore } from '../../lib/uiStore'

beforeEach(() => {
  localStorage.clear()
  uiStore.setDynamicTheme(false)
  uiStore.setTheme('dark')
})

describe('DynamicScope — home variant', () => {
  it('off (default): children render with no wrapper, no canvas, no grain', () => {
    render(
      <DynamicScope variant="home">
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
      <DynamicScope variant="home">
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
      <DynamicScope variant="home">
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
