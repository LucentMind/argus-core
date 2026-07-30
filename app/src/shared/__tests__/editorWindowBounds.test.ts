import { describe, it, expect } from 'vitest'
import { clampToDisplays } from '../editorWindowBounds'
import type { WindowBounds } from '../editorIpc'

const PRIMARY: WindowBounds = { x: 0, y: 0, width: 1920, height: 1080 }
const SECOND: WindowBounds = { x: 1920, y: 0, width: 1280, height: 1024 }

describe('clampToDisplays', () => {
  it('leaves a fully visible window untouched', () => {
    const b: WindowBounds = { x: 100, y: 100, width: 1100, height: 780 }
    expect(clampToDisplays(b, [PRIMARY])).toEqual(b)
  })

  it('leaves a window on a secondary display untouched', () => {
    const b: WindowBounds = { x: 2000, y: 50, width: 1100, height: 780 }
    expect(clampToDisplays(b, [PRIMARY, SECOND])).toEqual(b)
  })

  it('recenters a window whose display was unplugged', () => {
    const b: WindowBounds = { x: 2000, y: 50, width: 1100, height: 780 }
    const out = clampToDisplays(b, [PRIMARY])
    expect(out).toEqual({ x: 410, y: 150, width: 1100, height: 780 })
  })

  it('recenters a window dragged almost entirely off the bottom edge', () => {
    const b: WindowBounds = { x: 100, y: 1060, width: 1100, height: 780 }
    const out = clampToDisplays(b, [PRIMARY])
    expect(out.y).toBe(150)
  })

  it('shrinks a window larger than the display it lands on', () => {
    const b: WindowBounds = { x: -500, y: -500, width: 3000, height: 2000 }
    const out = clampToDisplays(b, [PRIMARY])
    expect(out).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('never returns a window below the minimum usable size', () => {
    const b: WindowBounds = { x: 9000, y: 9000, width: 200, height: 100 }
    const out = clampToDisplays(b, [PRIMARY])
    expect(out.width).toBe(720)
    expect(out.height).toBe(520)
  })

  it('falls back to default size when there are no displays to consult', () => {
    const b: WindowBounds = { x: 9000, y: 9000, width: 1100, height: 780 }
    expect(clampToDisplays(b, [])).toEqual({ x: 0, y: 0, width: 1100, height: 780 })
  })
})
