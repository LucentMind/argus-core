import { Fragment, useEffect, useState } from 'react'
import { Download, ExternalLink, RefreshCw, Trash2, X } from 'lucide-react'
import { SettingsSection, SettingRow, DraftInput, FIELD } from './settingsLayout'
import { ConfluenceSpaces, useConfluenceEnabled } from './ConfluenceSpaces'
import { Btn, Chip, IconBtn } from '../ui'
import { TierBadge } from './TierBadge'
import { withByline } from './byline'
import { settingsStore } from '../../lib/settingsStore'
import { confirm as askConfirm } from '../../lib/confirmStore'
import { UnifiedDiffView } from '../UnifiedDiffView'
import type { HivemindItem, HivemindPayload, LocalDivergence } from '../../../../shared/hivemind'
import type { SettingsPayload } from '../../../../shared/settings'
import type { SourceControlStatus } from '../../../../shared/sourcecontrol'

type UpdateConfirm = {
  kind: 'skill' | 'reference'
  name: string
  diff: string
  divergence: LocalDivergence
}

/** Shown wherever an action would leave a skills-user fork shadowing the HiveMind copy. */
const SHADOW_WARNING =
  "You have your own copy of this skill. It will keep being used — adopt upstream in the Library to switch to the team's version."

/** One Browse-tab row plus its inline update-diff panel, expanded directly beneath the row when active. */
function BrowseRow({
  it,
  busy,
  confirm,
  onInstall,
  onOpenUpdate,
  onReinstall,
  onCancel,
  onClaim,
  onUninstall
}: {
  it: HivemindItem
  busy: boolean
  confirm: UpdateConfirm | null
  onInstall: () => void
  onOpenUpdate: () => void
  onReinstall: () => void
  onCancel: () => void
  onClaim: () => void
  onUninstall: () => void
}): React.JSX.Element {
  const open = confirm !== null && confirm.kind === it.kind && confirm.name === it.name
  return (
    <Fragment>
      <SettingRow
        label={it.name}
        description={withByline(it.description, it.author)}
        badge={
          <>
            {it.localTier && <TierBadge tier={it.localTier} />}
            {it.updateAvailable ? <Chip tone="review">update available</Chip> : undefined}
          </>
        }
      >
        {it.updateAvailable ? (
          <Btn
            variant="outline"
            aria-label={`Update ${it.name}`}
            disabled={busy}
            onClick={onOpenUpdate}
          >
            Update
          </Btn>
        ) : it.installed ? null : (
          <Btn
            variant="outline"
            aria-label={`Download ${it.name}`}
            className="w-28 justify-center"
            disabled={busy}
            onClick={onInstall}
          >
            <Download size={13} aria-hidden="true" />
            Download
          </Btn>
        )}
        {it.kind === 'reference' && it.localTier === 'hivemind' && (
          <Btn
            variant="outline"
            aria-label={`Keep ${it.name} as mine`}
            disabled={busy}
            onClick={() => {
              void askConfirm({
                title: `Keep ${it.name} as yours?`,
                message:
                  'It becomes pushable to the HiveMind and future updates keep your authorship.',
                confirmLabel: 'Keep as mine'
              }).then((ok) => {
                if (ok) onClaim()
              })
            }}
          >
            Keep as mine
          </Btn>
        )}
        {(it.kind === 'skill'
          ? it.installed
          : it.localTier === 'hivemind' || it.localTier === 'confluence') && (
          <Btn
            variant="dangerSolid"
            aria-label={`Remove ${it.name}`}
            className="w-28 justify-center"
            disabled={busy}
            onClick={() => {
              void askConfirm({
                title: `Remove ${it.name}?`,
                message:
                  it.kind === 'skill'
                    ? 'Its skills-hivemind folder is removed; it stays available in Browse.'
                    : 'Its local references copy is removed; it stays available in Browse.',
                confirmLabel: 'Remove',
                danger: true
              }).then((ok) => {
                if (ok) onUninstall()
              })
            }}
          >
            <Trash2 size={13} aria-hidden="true" />
            Remove
          </Btn>
        )}
      </SettingRow>
      {it.shadowedByUser && !it.installed && (
        <div className="px-4 pb-3">
          <div className="rounded-r2 border border-hair bg-hair/40 px-2 py-1 text-xs text-mute">
            {SHADOW_WARNING}
          </div>
        </div>
      )}
      {open && confirm && (
        <div className="flex flex-col gap-2 px-4 py-3">
          {it.shadowedByUser && (
            <div className="rounded-r2 border border-hair bg-hair/40 px-2 py-1 text-xs text-mute">
              After this update: {SHADOW_WARNING}
            </div>
          )}
          {confirm.divergence.diverged && (
            <>
              <div className="rounded-r2 border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger">
                Your local copy of {it.name.split('/').pop()} differs from the version that would be
                installed. Updating replaces the content below with the team&apos;s version.
              </div>
              {/* diff can legitimately be empty (fail-closed path: clone unreadable, no pin to
                  compare against) — the banner above stands alone rather than rendering an
                  empty diff viewer. */}
              {confirm.divergence.diff && (
                <>
                  <span className="text-xs text-dim">Your edits — would be lost</span>
                  <UnifiedDiffView diff={confirm.divergence.diff} />
                </>
              )}
            </>
          )}
          {/* Independent of `diverged`: a confluence/-prefixed twin can be byte-identical (no
              content divergence) yet installing it still restamps trust_tier, silently costing
              the user their ability to push it. Render as a sibling, not nested in the diverged
              guard, so it still shows when diverged is false. */}
          {confirm.divergence.tierChange && (
            <div className="rounded-r2 border border-hair bg-hair/40 px-2 py-1 text-xs text-mute">
              Updating changes this file&apos;s tier from{' '}
              <span className="font-mono">{confirm.divergence.tierChange.from || 'none'}</span> to{' '}
              <span className="font-mono">{confirm.divergence.tierChange.to}</span>
              {confirm.divergence.tierChange.to === 'confluence' &&
                ' — it becomes owned by Confluence sync, and you will no longer be able to share it.'}
            </div>
          )}
          {confirm.diff ? (
            <>
              <span className="text-xs text-dim">Incoming change from the HiveMind</span>
              <UnifiedDiffView diff={confirm.diff} />
            </>
          ) : (
            <span className="font-mono text-xs text-dim">(no content diff — metadata only)</span>
          )}
          <div className="flex items-center gap-2">
            <Btn
              variant={confirm.divergence.diverged ? 'dangerSolid' : 'primary'}
              aria-label={
                confirm.divergence.diverged
                  ? `Overwrite my copy of ${it.name}`
                  : `Re-download ${it.name}`
              }
              disabled={busy}
              onClick={onReinstall}
            >
              <Download size={13} aria-hidden="true" />
              {confirm.divergence.diverged ? 'Overwrite my copy' : 'Re-download'}
            </Btn>
            <IconBtn aria-label="Cancel" title="Cancel" onClick={onCancel}>
              <X size={14} />
            </IconBtn>
          </div>
        </div>
      )}
    </Fragment>
  )
}

function matchesFilter(it: { name: string; description: string }, filter: string): boolean {
  if (!filter) return true
  const q = filter.toLowerCase()
  return it.name.toLowerCase().includes(q) || it.description.toLowerCase().includes(q)
}

export function HivemindSettings({
  payload: settingsPayload
}: {
  payload: SettingsPayload
}): React.JSX.Element {
  const [payload, setPayload] = useState<HivemindPayload | null>(null)
  const [gh, setGh] = useState<SourceControlStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [updateConfirm, setUpdateConfirm] = useState<UpdateConfirm | null>(null)
  const [check, setCheck] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle')
  const [checkError, setCheckError] = useState<string | null>(null)
  const [autoSyncing, setAutoSyncing] = useState(false)
  const [downloadAllProgress, setDownloadAllProgress] = useState<{
    kind: 'skill' | 'reference'
    done: number
    total: number
  } | null>(null)

  const g = settingsPayload.settings.hivemind
  const confluenceOn = useConfluenceEnabled()

  // Re-runs whenever the repo setting changes so the payload, gh status, and
  // readiness probe all refresh immediately after the user commits a new repo
  // (previously mount-only: the Browse list stayed dormant until re-entering the tab).
  useEffect(() => {
    let mounted = true
    void window.argus.hivemind
      .get()
      .then((p) => {
        if (!mounted) return
        setPayload(p)
        if (p.error) setError(p.error)
      })
      .catch((e) => mounted && setError(e instanceof Error ? e.message : String(e)))
    void window.argus.sourceControl.status().then((s) => mounted && setGh(s))
    if (g.repo.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- repo-keyed probe: set 'checking' immediately for instant feedback before the async check resolves
      setCheck('checking')
      setCheckError(null)
      void window.argus.hivemind.check().then((r) => {
        if (!mounted) return
        setCheck(r.ok ? 'ok' : 'fail')
        if (!r.ok) setCheckError(r.error)
      })
    } else {
      setCheck('idle')
    }
    return () => {
      mounted = false
    }
  }, [g.repo])

  // Auto-sync on entering this tab: fires once the reachability probe above confirms the
  // remote is reachable, so the Browse list is usually already fresh by the time the user
  // looks at it instead of requiring a manual Sync click. Deliberately NOT routed through
  // `run()` — staying off `busy` keeps Download/Remove/Update usable immediately, and a pull
  // with nothing new to fetch is typically instant anyway. Failures (offline, auth) are
  // swallowed: being unreachable when Settings happens to be opened is normal, not worth
  // interrupting the user for. The manual Sync button still surfaces errors via `run()`.
  useEffect(() => {
    if (check !== 'ok') return
    let mounted = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- check-keyed kickoff: set the spinner immediately before the async sync resolves
    setAutoSyncing(true)
    void window.argus.hivemind
      .sync()
      .then((p) => {
        if (mounted) setPayload(p)
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setAutoSyncing(false)
      })
    return () => {
      mounted = false
    }
  }, [check])

  async function run(fn: () => Promise<HivemindPayload>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const p = await fn()
      setPayload(p)
      if (p.error) setError(p.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function openUpdate(kind: 'skill' | 'reference', name: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const [diff, divergence] = await Promise.all([
        window.argus.hivemind.diff(kind, name),
        kind === 'reference'
          ? window.argus.hivemind.localDivergence(name)
          : Promise.resolve<LocalDivergence>({ diverged: false, diff: '', tierChange: null })
      ])
      setUpdateConfirm({ kind, name, diff, divergence })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** Shared by both Browse call sites (Skills and References) so "yes, destroy my work" has
   *  exactly one implementation. The ack must be read from `updateConfirm` before it is
   *  cleared, or the flag is always false by the time `install` runs. */
  function reinstall(kind: 'skill' | 'reference', name: string): void {
    const ack = updateConfirm?.divergence.diverged === true
    setUpdateConfirm(null)
    void run(() =>
      ack
        ? window.argus.hivemind.install(kind, name, { overwriteLocalEdits: true })
        : window.argus.hivemind.install(kind, name)
    )
  }

  /** Downloads every not-yet-installed item of one kind, one at a time — sequential rather
   *  than parallel so installs don't race each other writing into the same local clone dir.
   *  Best-effort: one failure doesn't stop the rest; failures are reported together at the end. */
  async function downloadAll(kind: 'skill' | 'reference', items: HivemindItem[]): Promise<void> {
    if (busy) return
    const targets = items.filter((it) => !it.installed && !it.updateAvailable)
    if (targets.length === 0) return
    setBusy(true)
    setError(null)
    const failed: string[] = []
    for (let i = 0; i < targets.length; i++) {
      setDownloadAllProgress({ kind, done: i, total: targets.length })
      try {
        const p = await window.argus.hivemind.install(kind, targets[i].name)
        setPayload(p)
        if (p.error) setError(p.error)
      } catch {
        failed.push(targets[i].name)
      }
    }
    setDownloadAllProgress(null)
    setBusy(false)
    if (failed.length > 0) setError(`Failed to download: ${failed.join(', ')}`)
  }

  const statusChip = ((): React.JSX.Element | null => {
    if (check === 'checking') return <Chip tone="neutral">checking…</Chip>
    if (check === 'fail')
      return (
        <Chip tone="danger" title={checkError ?? undefined}>
          not reachable
        </Chip>
      )
    if (payload?.state === 'ready') return <Chip tone="signal">synced</Chip>
    if (payload?.state === 'not-cloned') return <Chip tone="review">ready to sync</Chip>
    if (payload?.state === 'error') return <Chip tone="danger">error</Chip>
    return null
  })()

  const trimmedRepo = g.repo.trim()
  const isGithubSlug = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmedRepo)
  const repoSection = (
    <SettingsSection
      title="Repository"
      subtitle="The GitHub repo your team's skills and references are shared through."
    >
      {/* `stacked` (2026-08-01): the default SettingRow puts label+description and the control
          on ONE line, which needs the full content column. In this half-width panel that line
          squeezed the label to ~200px and left the input a cramped `w-56` beside it. Stacked
          gives the control its own full-width row underneath, which is what a narrow panel
          wants — the same reason the path-picker rows use it. */}
      <SettingRow
        stacked
        label="HiveMind repo"
        description="GitHub org/name of the shared skills & references repo. Blank keeps HiveMind features off."
        isDefault={g.repo === ''}
        onReset={() => void settingsStore.patch({ hivemind: { repo: null } })}
      >
        <DraftInput
          aria-label="HiveMind repo"
          // `w-full` rather than `w-56`: it now owns its row, so it should use it.
          className={`${FIELD} w-full min-w-0 font-mono`}
          placeholder="org/name"
          value={g.repo}
          onCommit={(v) => void settingsStore.patch({ hivemind: { repo: v.trim() } })}
        />
      </SettingRow>
      {trimmedRepo !== '' && (
        /**
         * `flex-wrap` + `min-w-0` (2026-08-01). This row was a single non-wrapping flex line
         * built when the section had the whole content column to itself. In the two-column
         * layout it does not fit, and a flex line that cannot fit does not clip — it *spills*:
         * the tail of "synced 22.7.2026, 15:02:43" rendered outside the card, on top of the
         * Confluence panel beside it. Wrapping is what keeps it inside its own column.
         *
         * The repo identity truncates rather than wraps (`min-w-0` + `truncate`): a URL broken
         * across lines is harder to read than an elided one, and `title` carries the full text.
         */
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {isGithubSlug ? (
              <button
                aria-label={`Open ${trimmedRepo} on GitHub`}
                title={`Open https://github.com/${trimmedRepo}`}
                className="inline-flex min-w-0 items-center gap-1 font-mono text-sm text-ink transition-colors hover:text-signal"
                onClick={() => void window.argus.openExternal(`https://github.com/${trimmedRepo}`)}
              >
                <span className="truncate">{trimmedRepo}</span>
                <ExternalLink size={12} className="shrink-0" aria-hidden="true" />
              </button>
            ) : (
              <span className="min-w-0 truncate font-mono text-sm text-ink" title={trimmedRepo}>
                {trimmedRepo}
              </span>
            )}
            <IconBtn
              aria-label="Sync"
              title="Sync HiveMind"
              className="ml-auto"
              disabled={busy || autoSyncing}
              onClick={() => void run(() => window.argus.hivemind.sync())}
            >
              <RefreshCw size={14} className={busy || autoSyncing ? 'animate-spin' : ''} />
            </IconBtn>
          </div>
          {/* Status on its own line, and wrapping within it. Guarded so a repo with no commit,
              no state chip and no sync yet does not leave an empty row's worth of gap. */}
          {(payload?.headCommit || statusChip || payload?.lastSynced) && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {payload?.headCommit && (
                <Chip tone="neutral">@ {payload.headCommit.slice(0, 7)}</Chip>
              )}
              {statusChip}
              {payload?.lastSynced && (
                <span className="text-xs text-mute">
                  synced {new Date(payload.lastSynced).toLocaleString()}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  )

  /**
   * The two upstreams this workspace subscribes to, as a left and a right panel (user-directed,
   * 2026-08-01). Confluence used to live on Sources, beside pack installation — but a Confluence
   * space and the HiveMind repo are the same *kind* of thing (a shared source someone else owns,
   * synced in and kept current), while a pack is machinery. Pairing them here is what makes the
   * Team page answer "where does my shared knowledge come from" in one screen.
   *
   * `lg:grid-cols-2`, so the pair stacks rather than crushes on a narrow window — each column
   * carries a repo path or a space name, neither of which survives a 300px column.
   *
   * Rendered by every return path below, including the dormant one: Confluence sync does not
   * depend on a HiveMind repo being set, so hiding it behind that would strand it.
   */
  // Confluence is dormant until a pack declares reference-routing rules (see
  // `useConfluenceEnabled`), so the pair can be a single panel — and when it is, the grid has to
  // collapse to one column too. Left at `lg:grid-cols-2` the repo panel would sit in a half-width
  // column with an empty half beside it, which reads as a panel that failed to load.
  const upstreams = (
    <div className={`grid items-start gap-6 ${confluenceOn ? 'lg:grid-cols-2' : ''}`}>
      {repoSection}
      {confluenceOn && <ConfluenceSpaces />}
    </div>
  )

  if (!payload) {
    return (
      <div className="flex flex-col gap-6">
        {upstreams}
        <div className="text-dim">loading…</div>
      </div>
    )
  }

  if (payload.state === 'dormant') {
    return (
      <div className="flex flex-col gap-6">
        {upstreams}
        <div className="px-1 py-2 text-sm text-dim">
          Set a HiveMind repo above to enable skill &amp; reference sharing.
        </div>
      </div>
    )
  }

  const ghProblem = gh && (!gh.installed || !gh.authenticated)
  const filtered = payload.items.filter((it) => matchesFilter(it, filter))
  const skills = filtered.filter((it) => it.kind === 'skill')
  const references = filtered.filter((it) => it.kind === 'reference')
  const downloadableSkills = skills.filter((it) => !it.installed && !it.updateAvailable)
  const downloadableReferences = references.filter((it) => !it.installed && !it.updateAvailable)

  /** Section-header action for "Download All" — omitted entirely when nothing in that
   *  section is downloadable, rather than rendering a dead button. */
  function downloadAllAction(
    kind: 'skill' | 'reference',
    targets: HivemindItem[]
  ): React.JSX.Element | undefined {
    if (targets.length === 0) return undefined
    return (
      <Btn
        variant="outline"
        aria-label={`Download all ${kind === 'skill' ? 'skills' : 'references'}`}
        disabled={busy}
        onClick={() => void downloadAll(kind, targets)}
      >
        <Download size={13} aria-hidden="true" />
        {downloadAllProgress && downloadAllProgress.kind === kind
          ? `Downloading… (${downloadAllProgress.done}/${downloadAllProgress.total})`
          : 'Download All'}
      </Btn>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {upstreams}

      {error && (
        <div
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
        >
          {error}
        </div>
      )}
      {ghProblem && (
        <div className="rounded-r2 border border-review/40 bg-review/10 px-3 py-2 text-xs text-ink">
          GitHub CLI {gh?.installed ? 'is not authenticated' : 'is not installed'} — pushing (and
          private repos) will fail. See Settings → Health.
        </div>
      )}

      {payload.state === 'not-cloned' && (
        <div className="text-sm text-dim">Not cloned yet — Sync to fetch the HiveMind.</div>
      )}

      <div className="flex flex-col gap-4">
        <input
          aria-label="Filter HiveMind content"
          className={`${FIELD} w-full`}
          placeholder="Filter by name or description…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        {filter && skills.length === 0 && references.length === 0 ? (
          <div className="px-1 py-2 text-sm text-dim">
            No HiveMind content matches &quot;{filter}&quot;.
          </div>
        ) : (
          <>
            {skills.length > 0 && (
              <SettingsSection
                title="Skills"
                action={downloadAllAction('skill', downloadableSkills)}
              >
                {skills.map((it) => (
                  <BrowseRow
                    key={`${it.kind}/${it.name}`}
                    it={it}
                    busy={busy}
                    confirm={updateConfirm}
                    onInstall={() =>
                      void run(() => window.argus.hivemind.install(it.kind, it.name))
                    }
                    onOpenUpdate={() => void openUpdate(it.kind, it.name)}
                    onReinstall={() => reinstall(it.kind, it.name)}
                    onCancel={() => setUpdateConfirm(null)}
                    onClaim={() => void run(() => window.argus.hivemind.claimReference(it.name))}
                    onUninstall={() =>
                      void run(() => window.argus.hivemind.uninstallSkill(it.name))
                    }
                  />
                ))}
              </SettingsSection>
            )}

            {references.length > 0 && (
              <SettingsSection
                title="References"
                action={downloadAllAction('reference', downloadableReferences)}
              >
                {references.map((it) => (
                  <BrowseRow
                    key={`${it.kind}/${it.name}`}
                    it={it}
                    busy={busy}
                    confirm={updateConfirm}
                    onInstall={() =>
                      void run(() => window.argus.hivemind.install(it.kind, it.name))
                    }
                    onOpenUpdate={() => void openUpdate(it.kind, it.name)}
                    onReinstall={() => reinstall(it.kind, it.name)}
                    onCancel={() => setUpdateConfirm(null)}
                    onClaim={() => void run(() => window.argus.hivemind.claimReference(it.name))}
                    onUninstall={() =>
                      void run(() => window.argus.hivemind.uninstallReference(it.name))
                    }
                  />
                ))}
              </SettingsSection>
            )}
          </>
        )}
      </div>
    </div>
  )
}
