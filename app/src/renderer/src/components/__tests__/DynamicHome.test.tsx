// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { DynamicHome } from '../DynamicHome'
import { uiStore } from '../../lib/uiStore'

beforeEach(() => {
  localStorage.clear()
  uiStore.setDynamicTheme(false)
  uiStore.setTheme('dark')
})

describe('DynamicHome', () => {
  it('off (default): children render with no wrapper, no canvas, no grain', () => {
    render(
      <DynamicHome>
        <span>inner</span>
      </DynamicHome>
    )
    expect(screen.getByText('inner')).toBeTruthy()
    expect(screen.queryByTestId('dynamic-home')).toBeNull()
    expect(screen.queryByTestId('ambient-fallback')).toBeNull()
    expect(screen.queryByTestId('ambient-canvas')).toBeNull()
  })

  it('on: scope class, ambient layer (jsdom fallback path), and grain mount', () => {
    uiStore.setDynamicTheme(true)
    render(
      <DynamicHome>
        <span>inner</span>
      </DynamicHome>
    )
    expect(screen.getByTestId('dynamic-home').className).toContain('dynamic-home')
    expect(screen.getByTestId('ambient-fallback')).toBeTruthy()
    expect(screen.getByText('inner')).toBeTruthy()
  })

  it('reacts live to the store toggling', () => {
    render(
      <DynamicHome>
        <span>inner</span>
      </DynamicHome>
    )
    expect(screen.queryByTestId('dynamic-home')).toBeNull()
    act(() => uiStore.setDynamicTheme(true))
    expect(screen.getByTestId('dynamic-home')).toBeTruthy()
    act(() => uiStore.setDynamicTheme(false))
    expect(screen.queryByTestId('dynamic-home')).toBeNull()
  })
})
