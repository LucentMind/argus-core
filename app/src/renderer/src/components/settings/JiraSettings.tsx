import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { settingsStore } from '../../lib/settingsStore'
import { Btn, MenuButton } from '../ui'
import { SettingsSection, SettingRow, FIELD } from './settingsLayout'
import { DEFAULT_CLONE_LINK_TYPES, type SettingsPayload } from '../../../../shared/settings'
import type { JiraLinkType } from '../../../../shared/jira'

/** `is cloned by ↔ clones` — the phrasing Jira itself shows on an issue, which is how a user
 *  recognises the type they mean when the name has been localised or renamed. */
function phrasing(t: JiraLinkType): string | undefined {
  if (!t.inward && !t.outward) return undefined
  return `${t.inward ?? '—'} ↔ ${t.outward ?? '—'}`
}

/**
 * Jira workspace settings. Rendered only when an Atlassian connector exists (see
 * ConnectorsSettings): every row here configures how Argus reads Jira, which is not a question
 * an install without the connector has.
 *
 * The clone link types used to be a column of full-width text inputs, one per entry, each
 * needing a name typed to match Jira exactly — and a mismatch is silent, since discovery simply
 * finds nothing. They are now chips, and new ones are picked from the site's own link-type
 * catalogue (user-directed, 2026-08-21). Typing a name by hand stays available: the catalogue
 * needs an authorized connector, and a user configuring one ahead of authorizing should not be
 * stuck.
 */
export function JiraSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  const jira = payload.settings.jira
  const [catalog, setCatalog] = useState<JiraLinkType[] | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')

  // One fetch per mount. Not retried on failure: the honest fallback is the text box, and a
  // settings page must not sit in a retry loop against an external service.
  useEffect(() => {
    let alive = true
    void window.argus.jira
      .linkTypes()
      .then((r) => {
        if (!alive) return
        if (r.ok) setCatalog(r.value)
        else setCatalogError(r.message)
      })
      .catch((err: Error) => {
        if (alive) setCatalogError(err.message)
      })
    return () => {
      alive = false
    }
  }, [])

  /** Patch `null`, not `[]`, once the last entry is gone: an empty ARRAY does not equal the
   *  non-empty default, so `stripDefaults` would keep it on disk and clone discovery would
   *  silently match nothing forever. `null` is the repo's reset idiom — deepMerge deletes the
   *  key and the next parse re-seeds ["Cloners"], which is what the row's copy promises. */
  function setTypes(next: string[]): void {
    const clean = next.map((t) => t.trim()).filter(Boolean)
    void settingsStore.patch({ jira: { cloneLinkTypes: clean.length ? clean : null } })
  }

  function add(name: string): void {
    const t = name.trim()
    // Case-insensitive, because that is how `cloneLinksOf` compares them: adding "cloners"
    // beside "Cloners" would look like two rules and behave as one.
    if (!t || jira.cloneLinkTypes.some((x) => x.toLowerCase() === t.toLowerCase())) return
    setTypes([...jira.cloneLinkTypes, t])
  }

  const selected = new Set(jira.cloneLinkTypes.map((t) => t.toLowerCase()))
  const offered = (catalog ?? []).filter((t) => !selected.has(t.name.toLowerCase()))

  const items = [
    ...offered.map((t) => ({
      label: t.name,
      title: phrasing(t),
      onSelect: () => add(t.name)
    })),
    // Always last, and always present: the catalogue can be empty (every type already chosen),
    // unreachable (no authorization yet), or simply missing the name an org uses on an issue
    // type Argus has not seen.
    { label: 'Type a name…', onSelect: () => setTyping(true) }
  ]

  return (
    <SettingsSection title="Jira" subtitle="How Argus reads the issues it is pointed at.">
      <SettingRow
        label="Clone link types"
        description={`Jira link-type names that mean "this ticket is a clone of that one" — what source-ticket discovery looks for on an issue. Compared case-insensitively. Remove every entry to go back to Jira's default ("${DEFAULT_CLONE_LINK_TYPES.join('", "')}").`}
        isDefault={
          jira.cloneLinkTypes.length === DEFAULT_CLONE_LINK_TYPES.length &&
          jira.cloneLinkTypes.every((t, i) => t === DEFAULT_CLONE_LINK_TYPES[i])
        }
        onReset={() => void settingsStore.patch({ jira: { cloneLinkTypes: null } })}
        stacked
      >
        {/* One flex COLUMN wrapping everything below, because `SettingRow`'s stacked variant
            lays its children out as a wrapping ROW: without this the hint text and the
            type-a-name box became flex items beside the chips and shared their line. */}
        <div className="flex w-full flex-col gap-1">
          {/* One wrapping row of chips, not one input per line: these are three words each, and a
            list of them is a set, not a form. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {jira.cloneLinkTypes.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-r2 border border-hair2 bg-hair/40 py-0.5 pl-2 pr-1 text-xs text-ink"
              >
                {t}
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  title={`Remove ${t}`}
                  className="rounded-r1 p-0.5 text-mute transition-colors hover:bg-hair hover:text-danger"
                  onClick={() => setTypes(jira.cloneLinkTypes.filter((x) => x !== t))}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            {jira.cloneLinkTypes.length === 0 && (
              <span className="text-xs text-mute">
                None — discovery falls back to Jira&apos;s default.
              </span>
            )}
            <MenuButton
              label="Add…"
              aria-label="Add clone link type"
              variant="outline"
              align="left"
              items={items}
            />
          </div>
          {typing && (
            <div className="flex items-center gap-1">
              <input
                className={`${FIELD} w-56`}
                aria-label="New clone link type"
                placeholder="Cloners"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    add(draft)
                    setDraft('')
                    setTyping(false)
                  } else if (e.key === 'Escape') {
                    setDraft('')
                    setTyping(false)
                  }
                }}
              />
              <Btn
                variant="outline"
                disabled={!draft.trim()}
                onClick={() => {
                  add(draft)
                  setDraft('')
                  setTyping(false)
                }}
              >
                Add
              </Btn>
            </div>
          )}
          {/* Stated, not silent: without it a user whose connector is not authorized sees a menu
            with one entry and no reason why. */}
          {catalogError && (
            <span className="text-xs text-mute">
              Jira&apos;s link types could not be listed ({catalogError}) — type the name instead.
            </span>
          )}
          {catalog !== null && catalog.length > 0 && offered.length === 0 && (
            <span className="text-xs text-mute">
              Every link type this site defines is already listed.
            </span>
          )}
        </div>
      </SettingRow>
    </SettingsSection>
  )
}
