// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { watchFullScreen } from '../fullScreen'

type Cb = (full: boolean) => void

function stubApi(opts: { initial?: boolean | Promise<boolean> } = {}): {
  emit: Cb
  off: () => void
} {
  let cb: Cb = () => {}
  const off = vi.fn()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).argus = {
    window: {
      isFullScreen: () => Promise.resolve(opts.initial ?? false),
      onFullScreenChanged: (fn: Cb) => {
        cb = fn
        return off
      }
    }
  }
  return { emit: (v) => cb(v), off }
}

const attr = (): string | null => document.documentElement.getAttribute('data-fullscreen')

describe('watchFullScreen', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-fullscreen')
  })

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).argus
  })

  it('seeds the attribute from the window state at startup — a reload can land in full screen', async () => {
    stubApi({ initial: true })
    watchFullScreen()
    await vi.waitFor(() => expect(attr()).toBe('true'))
  })

  it('stamps and clears the attribute as the window enters and leaves full screen', async () => {
    const api = stubApi()
    watchFullScreen()
    await vi.waitFor(() => expect(attr()).toBeNull())

    api.emit(true)
    expect(attr()).toBe('true')
    api.emit(false)
    expect(attr()).toBeNull()
  })

  // The seed describes the state when the request was SENT. A transition landing inside that
  // round trip is the fresher fact, and must not be undone when the reply arrives.
  it('does not let the initial read overwrite an event that arrived first', async () => {
    let resolveInitial: (v: boolean) => void = () => {}
    let cb: Cb = () => {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).argus = {
      window: {
        isFullScreen: () =>
          new Promise<boolean>((res) => {
            resolveInitial = res
          }),
        onFullScreenChanged: (fn: Cb) => {
          cb = fn
          return () => {}
        }
      }
    }
    watchFullScreen()

    cb(true)
    expect(attr()).toBe('true')
    resolveInitial(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(attr()).toBe('true')
  })

  it('unsubscribes and ignores events after teardown', async () => {
    const api = stubApi()
    const stop = watchFullScreen()
    await vi.waitFor(() => expect(attr()).toBeNull())
    stop()
    expect(api.off).toHaveBeenCalled()
    api.emit(true)
    expect(attr()).toBeNull()
  })

  it('is inert when preload predates the api', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).argus = {}
    expect(() => watchFullScreen()()).not.toThrow()
    expect(attr()).toBeNull()
  })
})
