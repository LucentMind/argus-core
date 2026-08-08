import { describe, it, expect, vi } from 'vitest'
import { TrayService, type TrayHandle, type TrayMenuItem } from '../tray'

/** A TrayService over fake Electron constructors that record what was built. */
const harness = (
  unreviewed: () => number
): {
  service: TrayService
  menus: TrayMenuItem[][]
  tooltips: string[]
  clicks: Record<string, () => void>
  destroyed: () => number
  showWindow: ReturnType<typeof vi.fn>
  showWindowAndFocusInbox: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
} => {
  const menus: TrayMenuItem[][] = []
  const tooltips: string[] = []
  const clicks: Record<string, () => void> = {}
  let destroyed = 0
  const showWindow = vi.fn()
  const showWindowAndFocusInbox = vi.fn()
  const quit = vi.fn()

  const tray: TrayHandle = {
    setToolTip: (t) => tooltips.push(t),
    setContextMenu: () => {},
    on: (event, cb) => {
      clicks[event] = cb
    },
    destroy: () => {
      destroyed++
    }
  }

  const service = new TrayService({
    createTray: () => tray,
    // The real Menu.buildFromTemplate returns an opaque Menu; the template is what we assert on.
    buildMenu: (template) => {
      menus.push(template)
      return template
    },
    icon: () => ({}),
    unreviewedCount: unreviewed,
    showWindow,
    showWindowAndFocusInbox,
    quit
  })

  return {
    service,
    menus,
    tooltips,
    clicks,
    destroyed: () => destroyed,
    showWindow,
    showWindowAndFocusInbox,
    quit
  }
}

const labels = (menu: TrayMenuItem[]): string[] =>
  menu.filter((i) => i.visible !== false).map((i) => i.label)

describe('TrayService', () => {
  it('hides the review item when nothing is unreviewed', () => {
    const h = harness(() => 0)
    h.service.start()
    expect(labels(h.menus[0])).toEqual(['Open Argus', 'Quit Argus'])
    expect(h.tooltips[0]).toBe('Argus')
  })

  it('shows the count, singular and plural', () => {
    const one = harness(() => 1)
    one.service.start()
    expect(labels(one.menus[0])).toEqual(['Open Argus', '1 run to review', 'Quit Argus'])
    expect(one.tooltips[0]).toBe('Argus — 1 run to review')

    const many = harness(() => 4)
    many.service.start()
    expect(labels(many.menus[0])).toContain('4 runs to review')
  })

  it('rebuilds the menu on refresh rather than mutating a stale one', () => {
    let n = 0
    const h = harness(() => n)
    h.service.start()
    n = 2
    h.service.refresh()
    expect(h.menus).toHaveLength(2)
    expect(labels(h.menus[0])).not.toContain('2 runs to review')
    expect(labels(h.menus[1])).toContain('2 runs to review')
  })

  it('opens the window from the icon click and from Open Argus', () => {
    const h = harness(() => 0)
    h.service.start()
    h.clicks.click()
    h.menus[0].find((i) => i.label === 'Open Argus')?.click?.()
    expect(h.showWindow).toHaveBeenCalledTimes(2)
  })

  // The whole reason the item names the inbox: opening the window alone can land the user on
  // Settings or a case, with the runs it just advertised nowhere in sight. The two actions are one
  // injected callback (not showWindow + a separate focusInbox) because only the caller in
  // main/index.ts knows whether the window had to be created, and therefore whether focusing the
  // inbox has to wait.
  it('opens the window and focuses the inbox from the review item, via one composed callback', () => {
    const h = harness(() => 3)
    h.service.start()
    h.menus[0].find((i) => i.label === '3 runs to review')?.click?.()
    expect(h.showWindowAndFocusInbox).toHaveBeenCalledTimes(1)
  })

  it('quits from the menu', () => {
    const h = harness(() => 0)
    h.service.start()
    h.menus[0].find((i) => i.label === 'Quit Argus')?.click?.()
    expect(h.quit).toHaveBeenCalledTimes(1)
  })

  it('is idempotent on start and safe to destroy twice', () => {
    const h = harness(() => 0)
    h.service.start()
    h.service.start()
    expect(h.menus).toHaveLength(1)
    h.service.destroy()
    h.service.destroy()
    expect(h.destroyed()).toBe(1)
  })

  // A refresh arriving after teardown is ordinary: routines:changed can fire while quit is in
  // flight. Touching a destroyed Tray throws "Object has been destroyed" in production.
  it('ignores a refresh after destroy', () => {
    const h = harness(() => 1)
    h.service.start()
    h.service.destroy()
    h.service.refresh()
    expect(h.menus).toHaveLength(1)
  })
})
