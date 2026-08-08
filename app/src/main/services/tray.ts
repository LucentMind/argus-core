/**
 * The system tray icon: the app's only surface once its last window is gone.
 *
 * Electron enters as injected constructors rather than imports, per the repo's DI convention
 * (main-process tests never `vi.mock('electron')`). That is not ceremony here — the spec makes
 * live verification of this feature mandatory precisely because a tray is invisible to jsdom, and
 * everything that CAN be checked cheaply (which items exist, what they say, that a refresh builds
 * a new menu) should not be paid for in manual passes on two platforms.
 *
 * It owns no routines state: `unreviewedCount` is a callback, read fresh on every rebuild.
 */

/** The structural slice of Electron's `Tray` this service uses. */
export interface TrayHandle {
  setToolTip(text: string): void
  setContextMenu(menu: unknown): void
  on(event: 'click', cb: () => void): void
  destroy(): void
}

/** The structural slice of an Electron `MenuItemConstructorOptions`. */
export interface TrayMenuItem {
  label: string
  click?: () => void
  visible?: boolean
}

export interface TrayServiceDeps {
  createTray: (icon: unknown) => TrayHandle
  buildMenu: (template: TrayMenuItem[]) => unknown
  /** Resolved lazily: the icon differs per platform and is built at wiring time. */
  icon: () => unknown
  /** Increment 3's SQL count over every unreviewed run, not the capped 50-row window. */
  unreviewedCount: () => number
  showWindow: () => void
  /**
   * Show the window (creating it if needed) and land on the run inbox once it can actually
   * receive that push. A window that has to be created cannot be told to focus the inbox in the
   * same tick — its `webContents` has only just started loading — so composing "show" and "focus
   * inbox" into one callback lets the caller (main/index.ts, which owns window lifecycle) decide
   * when the second half fires. This service deliberately does not: it only ever calls the two
   * actions it is given, never Electron's window APIs directly.
   */
  showWindowAndFocusInbox: () => void
  quit: () => void
}

export class TrayService {
  private tray: TrayHandle | null = null

  constructor(private deps: TrayServiceDeps) {}

  /** Idempotent — a second call is a no-op, not a second icon. */
  start(): void {
    if (this.tray) return
    this.tray = this.deps.createTray(this.deps.icon())
    // Left-click means the same thing as Open Argus. Windows and Linux deliver it; macOS opens
    // the menu instead, which is that platform's own convention and needs nothing from us.
    this.tray.on('click', () => this.deps.showWindow())
    this.render()
  }

  /** Rebuilds the menu and tooltip from the current count. Safe before start and after destroy. */
  refresh(): void {
    if (!this.tray) return
    this.render()
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private render(): void {
    const tray = this.tray
    if (!tray) return
    const n = this.deps.unreviewedCount()
    const reviewLabel = `${n} ${n === 1 ? 'run' : 'runs'} to review`
    // A fresh template every time: Electron menus are immutable once built, so a rebuild is the
    // only way a count change reaches the menu at all.
    tray.setContextMenu(
      this.deps.buildMenu([
        { label: 'Open Argus', click: () => this.deps.showWindow() },
        {
          label: reviewLabel,
          visible: n > 0,
          click: () => this.deps.showWindowAndFocusInbox()
        },
        { label: 'Quit Argus', click: () => this.deps.quit() }
      ])
    )
    tray.setToolTip(n > 0 ? `Argus — ${reviewLabel}` : 'Argus')
  }
}
