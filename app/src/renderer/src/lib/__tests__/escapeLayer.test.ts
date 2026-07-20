// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  pushEscapeLayer,
  transientFieldEscape,
  blurOnEscape,
  __resetEscapeLayersForTest
} from '../escapeLayer'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

afterEach(() => __resetEscapeLayersForTest())

function pressEscape(target?: Element): void {
  const el = target ?? document.body
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

describe('escapeLayer', () => {
  it('dispatches Escape to the only layer', () => {
    const onEscape = vi.fn()
    pushEscapeLayer({ onEscape })
    pressEscape()
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('dispatches to the top layer only', () => {
    const bottom = vi.fn()
    const top = vi.fn()
    pushEscapeLayer({ onEscape: bottom })
    pushEscapeLayer({ onEscape: top })
    pressEscape()
    expect(top).toHaveBeenCalledTimes(1)
    expect(bottom).not.toHaveBeenCalled()
  })

  it('a swallow layer consumes Escape and shields the layer beneath', () => {
    const bottom = vi.fn()
    pushEscapeLayer({ onEscape: bottom })
    pushEscapeLayer({ swallow: true })
    pressEscape()
    expect(bottom).not.toHaveBeenCalled()
  })

  it('popping restores dispatch to the layer beneath', () => {
    const bottom = vi.fn()
    const pop = pushEscapeLayer({ swallow: true })
    pushEscapeLayer({ onEscape: bottom })
    // remove the swallow layer from the middle of the stack
    pop()
    pressEscape()
    expect(bottom).toHaveBeenCalledTimes(1)
  })

  it('pops the correct entry when layers unmount out of order', () => {
    const a = vi.fn()
    const b = vi.fn()
    const popA = pushEscapeLayer({ onEscape: a })
    pushEscapeLayer({ onEscape: b })
    popA() // bottom layer removed while the top is still mounted
    pressEscape()
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
  })

  it('ignores non-Escape keys', () => {
    const onEscape = vi.fn()
    pushEscapeLayer({ onEscape })
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(onEscape).not.toHaveBeenCalled()
  })

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('ignores Escape targeting a %s', (tag) => {
    const onEscape = vi.fn()
    pushEscapeLayer({ onEscape })
    const el = document.createElement(tag)
    document.body.appendChild(el)
    pressEscape(el)
    expect(onEscape).not.toHaveBeenCalled()
    el.remove()
  })

  it('ignores Escape targeting a contentEditable element', () => {
    const onEscape = vi.fn()
    pushEscapeLayer({ onEscape })
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    document.body.appendChild(el)
    pressEscape(el)
    expect(onEscape).not.toHaveBeenCalled()
    el.remove()
  })

  it('does nothing when the stack is empty', () => {
    expect(() => pressEscape()).not.toThrow()
  })
})

describe('transientFieldEscape', () => {
  function fakeEvent(key: string, blur: () => void): ReactKeyboardEvent<HTMLElement> {
    return { key, currentTarget: { blur } } as unknown as ReactKeyboardEvent<HTMLElement>
  }

  it('clears a non-empty field without blurring', () => {
    const clear = vi.fn()
    const blur = vi.fn()
    transientFieldEscape(fakeEvent('Escape', blur), false, clear)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(blur).not.toHaveBeenCalled()
  })

  it('blurs an already-empty field without clearing', () => {
    const clear = vi.fn()
    const blur = vi.fn()
    transientFieldEscape(fakeEvent('Escape', blur), true, clear)
    expect(blur).toHaveBeenCalledTimes(1)
    expect(clear).not.toHaveBeenCalled()
  })

  it('ignores keys other than Escape', () => {
    const clear = vi.fn()
    const blur = vi.fn()
    transientFieldEscape(fakeEvent('Enter', blur), false, clear)
    expect(clear).not.toHaveBeenCalled()
    expect(blur).not.toHaveBeenCalled()
  })
})

describe('blurOnEscape', () => {
  it('blurs on Escape and ignores other keys', () => {
    const blur = vi.fn()
    blurOnEscape({ key: 'Escape', currentTarget: { blur } } as never)
    expect(blur).toHaveBeenCalledTimes(1)
    blurOnEscape({ key: 'a', currentTarget: { blur } } as never)
    expect(blur).toHaveBeenCalledTimes(1)
  })
})
