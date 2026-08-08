import { Fragment } from 'react'
import { X } from 'lucide-react'
import { IconBtn } from '../ui'
import { settingsStore, useSettingsPayload } from '../../lib/settingsStore'

export type KnowledgeHubPage = 'sources' | 'library' | 'proposals' | 'team'

/** The three stops a piece of knowledge makes, in order. `page` matches the settings nav id, so
 *  a step's label is the same word the sidebar uses for it — that is what lets the strip say
 *  "you are here" about a menu item rather than about an idea of its own. */
const STEPS: { page: KnowledgeHubPage; label: string; hint: string }[] = [
  { page: 'proposals', label: 'Proposals', hint: 'the agent drafts' },
  { page: 'library', label: 'Library', hint: 'you accept — the agent uses it' },
  { page: 'team', label: 'Team', hint: 'share to the hive, and back' }
]

/**
 * Where the page you are on sits in the knowledge loop (user-directed, 2026-08-08).
 *
 * This was a sentence describing the pipeline; it is now a status strip showing your position in
 * it. A sentence is read once and then reads as furniture, and it could not answer the question
 * the reader actually has on arriving at Library or Team — *which part of this am I in?* Three
 * steps, current one highlighted, each a link to its page.
 *
 * The active step wears `bg-hi text-ink` — deliberately the exact treatment the settings sidebar
 * gives the active nav item (`SettingsView`), so the strip and the rail highlight the same word
 * the same way instead of offering two competing answers to "you are here". `aria-current="step"`
 * carries it for screen readers, which is why the steps are an `<ol>` inside a labelled `<nav>`
 * rather than a row of buttons.
 *
 * The loop closes inside step 3's hint ("and back") rather than as a fourth arrow curving to
 * Library: the return trip is a property of sharing, not a place you navigate to, and drawing it
 * as a step would have implied a page that does not exist.
 *
 * Still dismissible, and still via `settings.ui.knowledgeStripDismissed` — orientation is worth
 * more than a hint was, but it is not worth more than the space someone who knows the loop would
 * rather give to their content.
 */
export function KnowledgeFlowStrip({
  current,
  onNavigate
}: {
  /** The page being shown, i.e. which step to highlight. */
  current: KnowledgeHubPage
  onNavigate: (page: KnowledgeHubPage) => void
}): React.JSX.Element | null {
  const payload = useSettingsPayload()
  if (!payload || payload.settings.ui.knowledgeStripDismissed) return null

  return (
    <nav
      aria-label="Knowledge flow"
      className="flex items-center gap-2 rounded-r2 surface-card px-2 py-1.5"
    >
      {/* `flex-wrap` + `min-w-0`: three labelled steps do not fit a narrow settings pane on one
          line, and a flex row that cannot fit does not clip — it spills past the card. */}
      <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-y-1">
        {STEPS.map((s, i) => {
          const active = s.page === current
          return (
            <Fragment key={s.page}>
              {i > 0 && (
                <li aria-hidden="true" className="px-1 text-xs text-faint">
                  →
                </li>
              )}
              <li className="min-w-0">
                <button
                  aria-current={active ? 'step' : undefined}
                  onClick={() => onNavigate(s.page)}
                  className={`flex min-w-0 items-center gap-1.5 rounded-r2 px-2 py-1 text-xs transition-colors ${
                    active ? 'bg-hi text-ink' : 'text-dim hover:bg-hair hover:text-ink'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-mono text-[10px] ${
                      active ? 'bg-signal/20 text-signal' : 'bg-hair text-mute'
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="font-medium">{s.label}</span>
                  {/* The hint is what the step MEANS, and it is the half a bare stepper loses.
                      Muted on both states so it never competes with the label it explains. */}
                  <span className="truncate text-mute">{s.hint}</span>
                </button>
              </li>
            </Fragment>
          )
        })}
      </ol>
      <IconBtn
        aria-label="Dismiss knowledge flow strip"
        title="Dismiss"
        size="xs"
        onClick={() => void settingsStore.patch({ ui: { knowledgeStripDismissed: true } })}
      >
        <X size={13} />
      </IconBtn>
    </nav>
  )
}
