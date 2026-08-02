// @vitest-environment jsdom
import { useRef } from 'react'
import { render } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PanelDock } from '../PanelDock'
import { panelsStore } from '../../lib/panelsStore'
import { uiStore } from '../../lib/uiStore'

// jsdom never lays out the page, so hostRef.getBoundingClientRect() cannot be exercised
// through real layout — these tests stub it directly and assert only the arithmetic
// PanelDock does on whatever rect it is handed: the DOCK_INSET_PX subtraction (Task 3's
// fix keeping the native view's hard corners off the case card's rounded ones) and its
// interaction with uiScale. Nothing here claims to verify actual on-screen pixels.
/* eslint-disable @typescript-eslint/no-empty-function */
class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
/* eslint-enable @typescript-eslint/no-empty-function */
globalThis.ResizeObserver = globalThis.ResizeObserver ?? RO

beforeEach(() => {
  localStorage.clear()
  uiStore.setUiScale(1.0)
  panelsStore.setCase('CASE-A')
  panelsStore.setPanels([
    { caseSlug: 'CASE-A', packId: 'pack', windowId: 'win', title: 'Text Viewer', floated: false }
  ])
  panelsStore.setActiveTab('CASE-A::pack::win')
  window.argus = {
    panels: {
      setBounds: vi.fn(async () => undefined),
      setVisible: vi.fn(async () => undefined)
    }
  } as never
})

/** Mounts PanelDock over a host div whose getBoundingClientRect is stubbed to `rect` before
 *  PanelDock's own mount effect can read it (a callback ref fires during commit, ahead of
 *  useEffect). */
function mountDock(rect: Partial<DOMRect>): void {
  function Host(): React.JSX.Element {
    const hostRef = useRef<HTMLDivElement | null>(null)
    return (
      <div>
        <div
          ref={(el) => {
            hostRef.current = el
            if (el) {
              vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
                width: 0,
                height: 0,
                x: 0,
                y: 0,
                toJSON: () => ({}),
                ...rect
              } as DOMRect)
            }
          }}
        />
        <PanelDock hostRef={hostRef} />
      </div>
    )
  }
  render(<Host />)
}

describe('PanelDock bounds inset', () => {
  it('insets left/right/bottom by DOCK_INSET_PX before applying uiScale', () => {
    uiStore.setUiScale(1.25)
    mountDock({ left: 100, top: 40, width: 800, height: 600 })
    expect(window.argus.panels.setBounds).toHaveBeenCalledWith(
      { caseSlug: 'CASE-A', packId: 'pack', windowId: 'win' },
      { x: 130, y: 50, width: 990, height: 745 }
    )
  })

  // width shrinks by TWO insets (left+right); height by ONE (bottom only, top is an interior
  // seam under the tab strip). That asymmetry is the whole point of this test — see PanelDock.
  it('at 1x scale, shrinks width by two insets and height by one, moves x by one inset, leaves y untouched', () => {
    mountDock({ left: 0, top: 0, width: 500, height: 300 })
    expect(window.argus.panels.setBounds).toHaveBeenCalledWith(
      { caseSlug: 'CASE-A', packId: 'pack', windowId: 'win' },
      { x: 4, y: 0, width: 492, height: 296 }
    )
  })
})
