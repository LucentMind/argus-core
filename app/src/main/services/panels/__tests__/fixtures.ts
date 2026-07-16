import type { PanelView, PanelViewFactory } from '../panelHost'

/**
 * A PanelView satisfying the full 11-member interface with inert no-ops.
 *
 * PanelView is wide but most tests exercise one or two members, so pass only
 * those in `over` and let the rest stay inert:
 *
 *   makeFakePanelView({ webContentsId: 501, sendCommand: (id) => sent.push(id) })
 */
export function makeFakePanelView(over: Partial<PanelView> = {}): PanelView {
  const noop = (): void => undefined
  return {
    webContentsId: 100,
    loadPanel: noop,
    pushTheme: noop,
    floatOut: noop,
    dockBack: noop,
    destroy: noop,
    focus: noop,
    setBounds: noop,
    setVisible: noop,
    sendCommand: noop,
    capturePage: () => Promise.resolve(Buffer.alloc(0)),
    ...over
  }
}

/**
 * A factory handing out `makeFakePanelView` instances with ascending
 * webContentsIds, plus the list of views it created (in creation order).
 */
export function makeFakePanelViewFactory(over: Partial<PanelView> = {}): {
  factory: PanelViewFactory
  views: PanelView[]
} {
  const views: PanelView[] = []
  let nextId = 100
  const factory: PanelViewFactory = {
    create() {
      const view = makeFakePanelView({ webContentsId: nextId++, ...over })
      views.push(view)
      return view
    }
  }
  return { factory, views }
}
