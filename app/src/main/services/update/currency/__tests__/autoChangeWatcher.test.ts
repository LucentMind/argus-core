import { describe, it, expect, vi } from 'vitest'
import { createAutoChangeWatcher } from '../autoChangeWatcher'

describe('createAutoChangeWatcher', () => {
  it('does not fire on the first check, even though there is no prior reading to compare to', () => {
    const onChange = vi.fn()
    const watcher = createAutoChangeWatcher({ getAuto: () => true, onChange })
    watcher.check()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('fires when auto flips from true to false', () => {
    let auto = true
    const onChange = vi.fn()
    const watcher = createAutoChangeWatcher({ getAuto: () => auto, onChange })
    watcher.check()
    auto = false
    watcher.check()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('fires when auto flips from false to true', () => {
    let auto = false
    const onChange = vi.fn()
    const watcher = createAutoChangeWatcher({ getAuto: () => auto, onChange })
    watcher.check()
    auto = true
    watcher.check()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('does not fire again on a repeated check with the same value', () => {
    let auto = true
    const onChange = vi.fn()
    const watcher = createAutoChangeWatcher({ getAuto: () => auto, onChange })
    watcher.check()
    auto = false
    watcher.check()
    watcher.check()
    watcher.check()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('fires once per toggle across multiple flips', () => {
    let auto = true
    const onChange = vi.fn()
    const watcher = createAutoChangeWatcher({ getAuto: () => auto, onChange })
    watcher.check()
    auto = false
    watcher.check()
    auto = true
    watcher.check()
    auto = false
    watcher.check()
    expect(onChange).toHaveBeenCalledTimes(3)
  })
})
