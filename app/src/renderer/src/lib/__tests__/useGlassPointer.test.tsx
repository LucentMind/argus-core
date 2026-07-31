// @vitest-environment jsdom
import { useRef } from 'react'
import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useGlassPointer } from '../useGlassPointer'

function Grid({ active }: { active: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useGlassPointer(ref, active)
  return (
    <div ref={ref} data-testid="grid">
      <div className="glass-card" data-testid="card">
        <span data-testid="inner">x</span>
      </div>
    </div>
  )
}

beforeEach(() => {
  // flush synchronously so assertions can run right after the event
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})
afterEach(() => vi.unstubAllGlobals())

describe('useGlassPointer', () => {
  it('writes card-local --mx/--my on pointermove over a glass card (via inner targets too)', () => {
    const { getByTestId } = render(<Grid active={true} />)
    fireEvent.pointerMove(getByTestId('inner'), { clientX: 120, clientY: 40 })
    const card = getByTestId('card')
    // jsdom rects are 0x0 at 0,0 → card-local coords equal client coords
    expect(card.style.getPropertyValue('--mx')).toBe('120.0px')
    expect(card.style.getPropertyValue('--my')).toBe('40.0px')
  })

  it('clears the vars when the pointer leaves the card', () => {
    const { getByTestId } = render(<Grid active={true} />)
    const card = getByTestId('card')
    fireEvent.pointerMove(card, { clientX: 10, clientY: 10 })
    expect(card.style.getPropertyValue('--mx')).not.toBe('')
    fireEvent.pointerOut(card, { relatedTarget: document.body })
    expect(card.style.getPropertyValue('--mx')).toBe('')
    expect(card.style.getPropertyValue('--my')).toBe('')
  })

  it('does not clear the vars when the pointer moves within the card', () => {
    const { getByTestId } = render(<Grid active={true} />)
    const card = getByTestId('card')
    fireEvent.pointerMove(card, { clientX: 10, clientY: 10 })
    expect(card.style.getPropertyValue('--mx')).not.toBe('')
    // leaving the card element for a child of the card is not a real exit
    fireEvent.pointerOut(card, { relatedTarget: getByTestId('inner') })
    expect(card.style.getPropertyValue('--mx')).toBe('10.0px')
    expect(card.style.getPropertyValue('--my')).toBe('10.0px')
  })

  it('attaches nothing when inactive', () => {
    const { getByTestId } = render(<Grid active={false} />)
    fireEvent.pointerMove(getByTestId('card'), { clientX: 10, clientY: 10 })
    expect(getByTestId('card').style.getPropertyValue('--mx')).toBe('')
  })
})
