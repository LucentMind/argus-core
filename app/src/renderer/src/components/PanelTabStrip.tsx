import { useSyncExternalStore } from 'react'
import { X, ExternalLink, PinOff, Plus } from 'lucide-react'
import { MenuButton } from './ui'
import { panelsStore } from '../lib/panelsStore'
import { CHAT_TAB } from '../lib/panelsStore'
import { externalAppsStore } from '../lib/externalAppsStore'
import { panelKeyStr, type PanelDecl, type PanelInfo, type PanelKey } from '../../../shared/panels'

const keyOf = (p: PanelInfo): PanelKey => ({
  caseSlug: p.caseSlug,
  packId: p.packId,
  windowId: p.windowId
})

export function PanelTabStrip({
  slug,
  sessionId,
  activeTab,
  onSelect
}: {
  slug: string
  sessionId: number | null
  activeTab: string
  onSelect: (tab: string) => void
}): React.JSX.Element {
  const st = useSyncExternalStore(
    (cb) => panelsStore.subscribe(cb),
    () => panelsStore.get()
  )
  const ext = useSyncExternalStore(
    (cb) => externalAppsStore.subscribe(cb),
    () => externalAppsStore.get()
  )

  async function launch(d: PanelDecl): Promise<void> {
    if (d.kind === 'externalApp') {
      await window.argus.externalApps.open({
        caseSlug: slug,
        sessionId,
        packId: d.packId,
        windowId: d.windowId
      })
      return // external apps get a presence chip, not a tab
    }
    await window.argus.panels.open({ caseSlug: slug, packId: d.packId, windowId: d.windowId, sessionId })
    onSelect(panelKeyStr({ caseSlug: slug, packId: d.packId, windowId: d.windowId }))
  }

  const launcherItems = st.decls.map((d) => ({
    label: d.title,
    onSelect: () => void launch(d)
  }))

  return (
    <div className="flex items-center gap-1 border-b border-hair bg-deep px-2">
      <TabButton active={activeTab === CHAT_TAB} onClick={() => onSelect(CHAT_TAB)} label="Chat" />
      {st.panels.map((p) => {
        const id = panelKeyStr(p)
        return (
          <div
            key={id}
            className={`group flex items-center gap-1 border-b-2 px-2 py-1.5 text-xs ${
              activeTab === id
                ? 'border-signal text-ink'
                : 'border-transparent text-dim hover:text-ink'
            }`}
          >
            <button className="max-w-40 truncate" onClick={() => onSelect(id)}>
              {p.title}
              {p.floated && <span className="ml-1 text-mute">(floated)</span>}
            </button>
            {p.floated ? (
              <button
                aria-label={`Dock ${p.title}`}
                title="Dock back"
                className="text-mute hover:text-ink"
                onClick={() => {
                  void window.argus.panels.dockBack(keyOf(p))
                  onSelect(id)
                }}
              >
                <PinOff size={12} />
              </button>
            ) : (
              <button
                aria-label={`Pop out ${p.title}`}
                title="Pop out"
                className="text-mute opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => void window.argus.panels.popOut(keyOf(p))}
              >
                <ExternalLink size={12} />
              </button>
            )}
            <button
              aria-label={`Close ${p.title}`}
              title="Close"
              className="text-mute opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
              onClick={() => {
                void window.argus.panels.close(keyOf(p))
                if (activeTab === id) onSelect(CHAT_TAB)
              }}
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
      {ext.apps.map((a) => {
        const k = { caseSlug: a.caseSlug, packId: a.packId, windowId: a.windowId }
        return (
          <div
            key={panelKeyStr(a)}
            className="flex items-center gap-1 rounded border border-hair px-2 py-1 text-xs text-dim"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${a.status === 'running' ? 'bg-signal' : 'bg-mute'}`}
            />
            <span className="max-w-32 truncate">{a.title}</span>
            {a.status === 'running' && (
              <button
                aria-label={`Focus ${a.title}`}
                title="Focus"
                className="text-mute hover:text-ink"
                onClick={() => void window.argus.externalApps.focus(k)}
              >
                <ExternalLink size={12} />
              </button>
            )}
            <button
              aria-label={`Stop ${a.title}`}
              title="Stop"
              className="text-mute hover:text-danger"
              onClick={() => void window.argus.externalApps.stop(k)}
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
      {launcherItems.length > 0 && (
        <div className="ml-1">
          <MenuButton
            label={<Plus size={14} aria-hidden="true" />}
            aria-label="Open panel"
            align="left"
            items={launcherItems}
          />
        </div>
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  label
}: {
  active: boolean
  onClick: () => void
  label: string
}): React.JSX.Element {
  return (
    <button
      className={`border-b-2 px-2 py-1.5 text-xs ${
        active ? 'border-signal text-ink' : 'border-transparent text-dim hover:text-ink'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}
