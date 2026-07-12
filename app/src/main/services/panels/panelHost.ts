import type { DatabaseSync } from 'node:sqlite'
import type { PanelKey, PanelInfo, PanelPermission, PanelRect } from '../../../shared/panels'
import { panelKeyStr } from '../../../shared/panels'
import type { PanelThemeName } from '../../../shared/panelTheme'
import { createPanelBridge, type PanelBridge } from './bridge'

export type { PanelKey }

/** Everything PanelHost needs to open a panel (main-side; permissions/entry come from windowDecls, not the renderer). */
export interface OpenPanelInput extends PanelKey {
  title: string
  entry: string
  uiDir: string
  network: string[]
  permissions: PanelPermission[]
  focus?: { evidenceId: number; line?: number }
  sessionId?: number | null
}

/**
 * The Electron surface PanelHost drives, injected so lifecycle logic stays
 * electron-free and unit-testable with a fake (house DI style).
 */
export interface PanelView {
  /** Identity of the underlying WebContents — proves reparent-not-reload and routes bridge calls. */
  readonly webContentsId: number
  loadPanel(url: string): void
  pushTheme(theme: PanelThemeName): void
  floatOut(title: string): void
  dockBack(): void
  destroy(): void
  focus(): void
  setBounds(rect: PanelRect): void
  setVisible(visible: boolean): void
}

/** Out-of-band notifications a real view raises back to the host (e.g. the user OS-closes a floated window). */
export interface PanelViewHooks {
  onFloatClosed(): void
}

export interface PanelViewFactory {
  create(input: OpenPanelInput, hooks: PanelViewHooks): PanelView
}

interface OpenPanel {
  input: OpenPanelInput
  view: PanelView
  bridge: PanelBridge
  floated: boolean
}

const entryBasename = (entry: string): string => entry.split('/').pop() ?? entry
const panelUrl = (input: OpenPanelInput): string =>
  `argus-panel://${input.packId}/${input.windowId}/${entryBasename(input.entry)}`

export class PanelHost {
  private readonly panels = new Map<string, OpenPanel>()
  private theme: PanelThemeName = 'dark'

  constructor(
    private readonly deps: {
      db: DatabaseSync
      argusHome: string
      writeSink?: import('./bridge').PanelWriteSink
      factory: PanelViewFactory
      onChange?: () => void
    }
  ) {}

  /** Open a panel; idempotent — re-opening focuses and re-points the focus evidence. */
  open(input: OpenPanelInput): PanelInfo {
    const key = panelKeyStr(input)
    const existing = this.panels.get(key)
    if (existing) {
      const prev = existing.input.focus
      const focusChanged =
        input.focus != null &&
        (prev?.evidenceId !== input.focus.evidenceId || prev?.line !== input.focus.line)
      existing.input = {
        ...existing.input,
        focus: input.focus,
        sessionId: input.sessionId ?? existing.input.sessionId
      }
      existing.bridge = this.buildBridge(existing.input)
      existing.view.focus()
      // A re-open carrying a new focus (e.g. "Open in" on a different evidence,
      // or on a panel already opened via the launcher) must actually re-render.
      // The idempotent path only re-points server state; a running panel already
      // called getCaseContext() and won't see it — so reload to re-run its boot().
      if (focusChanged) existing.view.loadPanel(panelUrl(existing.input))
      return infoOf(existing)
    }
    const view = this.deps.factory.create(input, {
      onFloatClosed: () => {
        const p = this.panels.get(key)
        if (p && p.floated) {
          p.floated = false
          this.deps.onChange?.()
        }
      }
    })
    const panel: OpenPanel = { input, view, bridge: this.buildBridge(input), floated: false }
    this.panels.set(key, panel)
    view.loadPanel(panelUrl(input))
    view.pushTheme(this.theme)
    return infoOf(panel)
  }

  close(key: PanelKey): void {
    const p = this.panels.get(panelKeyStr(key))
    if (!p) return
    p.view.destroy()
    this.panels.delete(panelKeyStr(key))
  }

  focus(key: PanelKey): void {
    this.panels.get(panelKeyStr(key))?.view.focus()
  }

  popOut(key: PanelKey): void {
    const p = this.panels.get(panelKeyStr(key))
    if (!p || p.floated) return
    p.view.floatOut(p.input.title)
    p.floated = true
  }

  dockBack(key: PanelKey): void {
    const p = this.panels.get(panelKeyStr(key))
    if (!p || !p.floated) return
    p.view.dockBack()
    p.floated = false
  }

  setBounds(key: PanelKey, rect: PanelRect): void {
    this.panels.get(panelKeyStr(key))?.view.setBounds(rect)
  }

  setVisible(key: PanelKey, visible: boolean): void {
    this.panels.get(panelKeyStr(key))?.view.setVisible(visible)
  }

  /** Tear down every panel for a case (case switch/close). */
  closeCase(caseSlug: string): void {
    for (const [k, p] of this.panels) {
      if (p.input.caseSlug === caseSlug) {
        p.view.destroy()
        this.panels.delete(k)
      }
    }
  }

  /** Tear down every panel (app shutdown). */
  closeAll(): void {
    for (const p of this.panels.values()) p.view.destroy()
    this.panels.clear()
  }

  list(caseSlug?: string): PanelInfo[] {
    const out: PanelInfo[] = []
    for (const p of this.panels.values()) {
      if (!caseSlug || p.input.caseSlug === caseSlug) out.push(infoOf(p))
    }
    return out
  }

  setTheme(theme: PanelThemeName): void {
    this.theme = theme
    for (const p of this.panels.values()) p.view.pushTheme(theme)
  }

  /**
   * The bridge for the panel owning `webContentsId`. Bridge calls are routed by
   * sender id — never by renderer-supplied identity — so a panel can only reach
   * its own bound case.
   */
  bridgeForWebContents(webContentsId: number): PanelBridge | null {
    for (const p of this.panels.values()) {
      if (p.view.webContentsId === webContentsId) return p.bridge
    }
    return null
  }

  private buildBridge(input: OpenPanelInput): PanelBridge {
    return createPanelBridge({
      db: this.deps.db,
      argusHome: this.deps.argusHome,
      caseSlug: input.caseSlug,
      permissions: input.permissions,
      focus: input.focus,
      sessionId: input.sessionId ?? null,
      writeSink: this.deps.writeSink
    })
  }
}

function infoOf(p: OpenPanel): PanelInfo {
  return {
    caseSlug: p.input.caseSlug,
    packId: p.input.packId,
    windowId: p.input.windowId,
    title: p.input.title,
    floated: p.floated
  }
}
