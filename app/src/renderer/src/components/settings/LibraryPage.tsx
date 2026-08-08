import { useEffect, useState, Fragment } from 'react'
import { HandGrab, Pencil, Share2, Trash2, type LucideIcon } from 'lucide-react'
import {
  SettingsSection,
  SettingRow,
  SettingsSkeleton,
  Switch,
  RowActions,
  RowToggle
} from './settingsLayout'
import { Btn, Chip, IconBtn, MenuButton } from '../ui'
import { ProposalsBanner } from './ProposalsBanner'
import { ForkSkillDialog } from './ForkSkillDialog'
import { ImportSkillsDialog } from './ImportSkillsDialog'
import { SharePushDialog, PushReceiptChip } from './SharePushDialog'
import { useSharePush } from './useSharePush'
import { RefViewer, MarkdownViewer } from '../references/RefViewer'
import { TierBadge } from './TierBadge'
import { withByline } from './byline'
import { accessStore } from '../../lib/accessStore'
import { confirm } from '../../lib/confirmStore'
import { useRefSyncPayload } from '../../lib/referenceSyncStore'
import {
  PUSHABLE_TIERS,
  HIVE_MANAGED_TIERS,
  TIER_LABELS,
  TIER_EXPLANATIONS
} from '../../../../shared/trustTiers'
import type { TrustTier } from '../../../../shared/trustTiers'
import type { SkillListItem } from '../../../../shared/memoryIpc'
import type { ReferenceStatus } from '../../../../shared/referenceSync'
import type { SkillUsageRow, ReferenceUsageRow } from '../../../../shared/observability'
import type { ProposalType } from '../../../../shared/proposals'
import type { EditorOpenRequest } from '../../../../shared/editorIpc'

/** Proposal types that land in the library — union of the old Skills + References banners (spec §3.5). */
// eslint-disable-next-line react-refresh/only-export-components -- constant co-located with the component it configures; see MetricCards.tsx for the same pattern
export const LIBRARY_TYPES: readonly ProposalType[] = [
  'skill-new',
  'skill-edit',
  'reference-edit',
  'recipe'
]

export type LibraryKind = 'skill' | 'reference'

/** Group order: what you own, then what you subscribe to, then what ships with a pack. */
const GROUP_ORDER = ['yours', 'subscribed', 'built-in'] as const
type GroupId = (typeof GROUP_ORDER)[number]
const GROUP_TITLE: Record<GroupId, string> = {
  yours: 'Yours',
  subscribed: 'Subscribed',
  'built-in': 'Built-in'
}
/** Each subtitle states the group's rights — the same rights its rows' buttons express. */
const GROUP_SUBTITLE: Record<GroupId, string> = {
  yours: 'You own these. Edit, delete, or share them with your team.',
  subscribed: 'Owned upstream and kept current. Claim one to make it yours.',
  'built-in':
    'Ships with an installed pack or Argus core. Read-only — contribute to the pack or Argus core to change these.'
}
/** Teaching empty states. Groups without an entry are hidden when empty. */
const GROUP_EMPTY: Partial<Record<GroupId, string>> = {
  yours: "Nothing yet — accept an agent proposal, or claim something from your team's HiveMind.",
  subscribed: "Nothing subscribed — browse your team's HiveMind under Settings → Team."
}

/**
 * A row action, as an icon (user-directed, 2026-08-01).
 *
 * Every action on a Library row is now icon-only and lives inside {@link RowActions}, where the
 * whole set fades in together on hover. Three word-labelled buttons per row put ~200px of
 * permanent chrome on the right of every entry and made the list read as a toolbar with names
 * attached; the icons are the same vocabulary the row's own viewer and the Confluence cards
 * already use.
 *
 * `title` carries what the label used to say, and `aria-label` (required) keeps the name in the
 * accessibility tree — dropping the visible text must not drop the name.
 */
function RowAction({
  icon: Icon,
  label,
  title,
  danger,
  disabled,
  onClick
}: {
  icon: LucideIcon
  /** Accessible name — what the visible label used to be, plus the row it acts on. */
  label: string
  /** Tooltip. Defaults to the verb alone, since the name already carries the row. */
  title?: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <IconBtn
      size="lg"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      // `!` markers: IconBtn's own `text-dim`/`hover:text-ink` are equal specificity, so a bare
      // appended `text-danger` loses on stylesheet source order alone (see FindingCard.tsx's
      // delete button for the same trap).
      className={danger ? 'text-danger! hover:bg-danger/10! hover:text-danger!' : ''}
    >
      <Icon size={21} aria-hidden="true" />
    </IconBtn>
  )
}

function errorAlert(message: string): React.JSX.Element {
  return (
    <div role="alert" className="rounded-r2 border border-danger/30 px-3 py-2 text-xs text-danger">
      {message}
    </div>
  )
}

/**
 * Tier → group. Derived from the shared sets rather than re-listing tiers: `PUSHABLE_TIERS`
 * is exactly what the user may share, `HIVE_MANAGED_TIERS` exactly what an upstream owns.
 * Anything else — `bundled`, an unknown tier, a reference with no frontmatter — is built-in.
 */
function groupOf(tier: string | null): GroupId {
  if (tier !== null && (PUSHABLE_TIERS as readonly string[]).includes(tier)) return 'yours'
  if (tier !== null && (HIVE_MANAGED_TIERS as readonly string[]).includes(tier)) return 'subscribed'
  return 'built-in'
}

/**
 * The Library (spec §3.2): one list of knowledge assets — skills + reference
 * files — grouped by rights, kind mixed within a group. Per-kind actions:
 * enable/disable + delete/adopt for skills; viewer for references; Share on
 * pushable rows (Tier 2 machinery).
 */
export function LibraryPage({
  initialKind,
  onReviewProposals
}: {
  initialKind?: LibraryKind
  onReviewProposals?: (types: readonly ProposalType[]) => void
} = {}): React.JSX.Element {
  const [skills, setSkills] = useState<SkillListItem[] | null>(null)
  const refPayload = useRefSyncPayload()
  const [error, setError] = useState<string | null>(null)
  const [skillUsage, setSkillUsage] = useState<Map<string, SkillUsageRow> | null>(null)
  const [refUsage, setRefUsage] = useState<Map<string, ReferenceUsageRow> | null>(null)
  const [viewer, setViewer] = useState<{ kind: LibraryKind; name: string } | null>(null)
  // the skill being forked, while the "Edit a copy" name dialog is open
  const [forking, setForking] = useState<SkillListItem | null>(null)
  const [importing, setImporting] = useState(false)
  // one dialog serves both kinds — keyed `${kind}/${name}` like push receipts
  const [sharing, setSharing] = useState<string | null>(null)
  const [sharePushing, setSharePushing] = useState(false)
  const { shareReady, shareTip, pushes, hiveItems, refresh: refreshShare } = useSharePush()
  const [kind, setKind] = useState<'all' | LibraryKind>(initialKind ?? 'all')
  const [query, setQuery] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<GroupId>>(new Set())
  // null = no active search; otherwise the set of reference files matching name/content
  const [matches, setMatches] = useState<Set<string> | null>(null)

  useEffect(() => {
    if (!query.trim()) return
    let cancelled = false
    const t = setTimeout(() => {
      void window.argus.refsync.searchRefs(query).then((names) => {
        if (!cancelled) setMatches(new Set(names))
      })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query])

  useEffect(() => {
    let mounted = true
    void window.argus.skills
      .list()
      .then((p) => {
        if (mounted) setSkills(p.skills)
      })
      .catch((err) => {
        if (mounted) setError((err as Error).message)
      })
    void window.argus.usage
      .stats()
      .then((u) => {
        if (!mounted) return
        setSkillUsage(new Map(u.skills.map((s) => [s.name, s])))
        setRefUsage(new Map(u.references.map((r) => [r.relPath, r])))
      })
      .catch(() => undefined)
    return () => {
      mounted = false
    }
  }, [])

  // The editor lives in its own window now, so a save can land in a process this page knows
  // nothing about. Mirrors what references already get from refsync:changed via
  // referenceSyncStore — the broadcast payload IS the new list, so no refetch here.
  useEffect(() => window.argus.skills.onChanged((p) => setSkills(p.skills)), [])

  /**
   * Every Edit / New button goes through here rather than `void`-ing the IPC. The editor is a
   * real BrowserWindow created in main now, so this can genuinely reject — a bad preload path, a
   * packaging regression that leaves out `editor.html`, display enumeration failing. `void`
   * attaches no rejection handler, so the button would simply do nothing, with no error anywhere.
   * The code this replaced was a local `setState` and could not fail.
   */
  function openEditor(req: EditorOpenRequest): void {
    window.argus.editor.open(req).catch((err) => setError((err as Error).message))
  }

  async function toggle(s: SkillListItem, v: boolean): Promise<void> {
    await accessStore.patch({ skills: { [`${s.tier}/${s.name}`]: v } })
    setSkills((await window.argus.skills.list()).skills) // enablement is computed main-side
  }

  /** Delete the skills-user copy — plain delete, or "adopt upstream" when it shadows a hivemind install. */
  async function removeUserSkill(s: SkillListItem, adopt: boolean): Promise<void> {
    const prompt = adopt
      ? {
          title: `Adopt the HiveMind version of "${s.name}"?`,
          message:
            'Your local copy in skills-user is deleted and the downloaded HiveMind skill takes over. ' +
            'Any edits you have not shared to the HiveMind are lost.',
          confirmLabel: 'Adopt'
        }
      : {
          title: `Delete user skill "${s.name}"?`,
          message: 'Its skills-user folder is removed.',
          confirmLabel: 'Delete',
          danger: true
        }
    if (!(await confirm(prompt))) return
    setError(null)
    try {
      setSkills((await window.argus.skills.deleteUser(s.name)).skills)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /** Fork a bundled/hivemind skill into skills-user (optionally under a new name — that's how
   *  a user gets a private variant instead of a PR against the team's copy), then edit the copy.
   *  Errors (illegal name, or the collision forkSkill refuses) surface inline in the dialog,
   *  which is why they are NOT caught here — ForkSkillDialog's submit() does that and keeps
   *  itself open so the user can retry with a different name. */
  async function doFork(s: SkillListItem, newName: string): Promise<void> {
    // close the viewer first: a failure below must land on a visible page, not
    // behind the still-open modal (spec finding 2) — the fork dialog itself stays on top
    setViewer(null)
    const { name, skills } = await window.argus.skills.fork(s.name, newName)
    setSkills(skills)
    setForking(null)
    openEditor({ kind: 'skill', name, mode: 'edit' })
  }

  /** Claim a hivemind reference (restamp to user tier), then edit it. */
  async function claimThenEdit(r: ReferenceStatus): Promise<void> {
    const ok = await confirm({
      title: `Make "${r.file}" yours?`,
      message:
        'It is restamped as your own reference and becomes shareable. Updates no longer track HiveMind.',
      confirmLabel: 'Claim'
    })
    if (!ok) return
    setError(null)
    // close the viewer first: a failure below must land on a visible page, not
    // behind the still-open modal (spec finding 2)
    setViewer(null)
    try {
      await window.argus.hivemind.claimReference(r.file)
      openEditor({ kind: 'reference', name: r.file, mode: 'edit' })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function removeHiveSkill(s: SkillListItem): Promise<void> {
    const ok = await confirm({
      title: `Remove ${s.name}?`,
      message: 'Its skills-hivemind folder is removed; it stays available in Browse.',
      confirmLabel: 'Remove',
      danger: true
    })
    if (!ok) return
    setError(null)
    try {
      await window.argus.hivemind.uninstallSkill(s.name)
      setSkills((await window.argus.skills.list()).skills)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /** Hand-owned tiers are permanently deleted; hive-managed tiers uninstall (Browse keeps them). */
  async function removeReference(r: ReferenceStatus): Promise<void> {
    const handOwned = r.tier !== 'hivemind' && r.tier !== 'confluence'
    const ok = await confirm(
      handOwned
        ? {
            title: `Delete reference "${r.file}"?`,
            message: 'Its references copy is permanently deleted.',
            confirmLabel: 'Delete',
            danger: true
          }
        : {
            title: `Remove ${r.file}?`,
            message: 'Its local references copy is removed; it stays available in Browse.',
            confirmLabel: 'Remove',
            danger: true
          }
    )
    if (!ok) return
    setError(null)
    try {
      if (handOwned) await window.argus.refsync.deleteRef(r.file)
      else await window.argus.hivemind.uninstallReference(r.file)
      // list refresh arrives via the refsync:changed broadcast (main-side, Task 2)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /** Restamp a hive-installed reference as the user's own — it moves to Yours and becomes pushable. */
  async function claimReference(r: ReferenceStatus): Promise<void> {
    const ok = await confirm({
      title: `Claim "${r.file}"?`,
      message:
        'It becomes yours to edit, delete, and share. Upstream updates stop appearing in this list, though you can still redownload it from Browse.',
      confirmLabel: 'Claim'
    })
    if (!ok) return
    setError(null)
    try {
      await window.argus.hivemind.claimReference(r.file)
      refreshShare()
      // the reference list refresh arrives via the refsync:changed broadcast
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (!skills || !refPayload) {
    // a failed initial load would otherwise leave the page skeletal forever
    if (error) return errorAlert(error)
    return <SettingsSkeleton rows={5} />
  }
  const references = refPayload.references

  const q = query.trim().toLowerCase()
  const activeMatches = q ? matches : null
  const filtering = kind !== 'all' || q !== ''

  function skillVisible(s: SkillListItem): boolean {
    if (kind === 'reference') return false
    if (q && !s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q))
      return false
    return true
  }
  function refVisible(r: ReferenceStatus): boolean {
    if (kind === 'skill') return false
    if (q && !(activeMatches?.has(r.file) ?? false)) return false
    return true
  }

  function skillRow(s: SkillListItem): React.JSX.Element {
    const adopt = s.tier === 'user' && s.shadows.includes('hivemind')
    const receipt = pushes[`skill/${s.name}`]
    const u = skillUsage?.get(s.name)
    const hive = hiveItems.get(`skill/${s.name}`)
    return (
      <Fragment key={`skill/${s.name}`}>
        <SettingRow
          label={s.name}
          onOpen={() => setViewer({ kind: 'skill', name: s.name })}
          description={withByline(s.description, groupOf(s.tier) === 'built-in' ? null : s.author)}
          badge={
            <>
              <Chip tone="neutral">skill</Chip>
              {groupOf(s.tier) !== 'built-in' && <TierBadge tier={s.tier} />}
              {s.tier === 'hivemind' && hive?.updateAvailable && <Chip tone="review">update</Chip>}
              {s.shadows.length > 0 && (
                <Chip tone="review">
                  overrides {s.shadows.map((t) => TIER_LABELS[t as TrustTier]).join(', ')}
                </Chip>
              )}
              {adopt && (
                <Chip tone={s.shadowDiverged ? 'review' : 'neutral'}>
                  {s.shadowDiverged ? 'differs from hivemind' : 'duplicate of hivemind'}
                </Chip>
              )}
              {u &&
                (u.activationCount > 0 ? (
                  <Chip tone="neutral">
                    {`${u.activationCount}× · last ${u.lastActivatedAt!.slice(0, 10)}`}
                  </Chip>
                ) : (
                  <Chip tone="neutral">never activated</Chip>
                ))}
              {receipt && <PushReceiptChip name={s.name} receipt={receipt} />}
            </>
          }
        >
          <RowActions>
            {s.tier === 'user' && (
              <>
                <RowAction
                  icon={Pencil}
                  label={`Edit · ${s.name}`}
                  title="Edit"
                  onClick={() => openEditor({ kind: 'skill', name: s.name, mode: 'edit' })}
                />
                <RowAction
                  icon={Share2}
                  label={`Share ${s.name} to HiveMind`}
                  title={shareTip}
                  // sharePushing: opening another row's dialog would unmount an
                  // in-flight push and its PR URL would never be shown
                  disabled={!shareReady || sharePushing}
                  onClick={() =>
                    setSharing(sharing === `skill/${s.name}` ? null : `skill/${s.name}`)
                  }
                />
                {/* "Adopt upstream" stays a worded button: it is not one of the three
                    recurring row verbs, and no icon carries "delete mine so the team's copy
                    wins" on its own. It also appears on a handful of rows, not on every one,
                    so it costs the column nothing at rest. Delete/Adopt is last: the
                    destructive action anchors the end of the row (user-directed, 2026-08-05). */}
                {adopt ? (
                  <Btn
                    variant="outline"
                    aria-label={`Adopt upstream · ${s.name}`}
                    title="Delete your copy so the team's version is used again"
                    onClick={() => void removeUserSkill(s, true)}
                  >
                    Adopt upstream
                  </Btn>
                ) : (
                  <RowAction
                    icon={Trash2}
                    danger
                    label={`Delete · ${s.name}`}
                    title="Delete"
                    onClick={() => void removeUserSkill(s, false)}
                  />
                )}
              </>
            )}
            {s.tier === 'hivemind' && (
              <RowAction
                icon={Trash2}
                danger
                label={`Remove · ${s.name}`}
                title="Remove"
                onClick={() => void removeHiveSkill(s)}
              />
            )}
          </RowActions>
          <RowToggle>
            <Switch
              checked={s.enabled}
              onChange={(v) => void toggle(s, v)}
              aria-label={`enabled · ${s.tier}/${s.name}`}
            />
          </RowToggle>
        </SettingRow>
        {sharing === `skill/${s.name}` && (
          <SharePushDialog
            kind="skill"
            name={s.name}
            onClose={() => {
              setSharing(null)
              refreshShare()
            }}
            onBusyChange={setSharePushing}
          />
        )}
      </Fragment>
    )
  }

  function refRow(r: ReferenceStatus): React.JSX.Element {
    const receipt = pushes[`reference/${r.file}`]
    const canShare = r.tier !== null && (PUSHABLE_TIERS as readonly string[]).includes(r.tier)
    const u = refUsage?.get(r.file)
    const hive = hiveItems.get(`reference/${r.file}`)
    const canClaim = r.tier === 'hivemind' && (hive?.installed ?? true)
    // Hand-owned tiers are deleted for good; hive-managed ones merely uninstall. The verb is
    // hoisted because it is now the tooltip AND the accessible name (see removeReference).
    const removeVerb = r.tier !== 'hivemind' && r.tier !== 'confluence' ? 'Delete' : 'Remove'
    // withByline needs a plain string to append "· by <name>" to — build the same text this
    // row has always shown (synced/read-count meta) as one string rather than a JSX fragment.
    const descText =
      (r.lastSynced ? `last synced ${r.lastSynced.slice(0, 10)}` : 'never synced') +
      (u
        ? ` · ${
            u.readCount === 0
              ? 'never read'
              : `${u.readCount} reads · last ${u.lastReadAt!.slice(0, 10)}`
          }`
        : '')
    return (
      <Fragment key={`reference/${r.file}`}>
        <SettingRow
          label={r.file}
          onOpen={() => setViewer({ kind: 'reference', name: r.file })}
          description={withByline(descText, groupOf(r.tier) === 'built-in' ? null : r.author)}
          badge={
            <>
              <Chip tone="neutral">reference</Chip>
              {r.tier !== null && groupOf(r.tier) !== 'built-in' && <TierBadge tier={r.tier} />}
              {r.tier === 'hivemind' && hive?.updateAvailable && <Chip tone="review">update</Chip>}
              {r.stale && <Chip tone="danger">stale</Chip>}
              {receipt && <PushReceiptChip name={r.file} receipt={receipt} />}
            </>
          }
        >
          <RowActions>
            {canClaim && (
              <RowAction
                icon={HandGrab}
                label={`Claim · ${r.file}`}
                title="Make this yours — editable, deletable, shareable"
                onClick={() => void claimReference(r)}
              />
            )}
            {r.tier !== 'bundled' &&
              !(HIVE_MANAGED_TIERS as readonly string[]).includes(r.tier ?? '') && (
                <RowAction
                  icon={Pencil}
                  label={`Edit · ${r.file}`}
                  title="Edit"
                  onClick={() => openEditor({ kind: 'reference', name: r.file, mode: 'edit' })}
                />
              )}
            {canShare && (
              <RowAction
                icon={Share2}
                label={`Share ${r.file} to HiveMind`}
                title={shareTip}
                // sharePushing: opening another row's dialog would unmount an
                // in-flight push and its PR URL would never be shown
                disabled={!shareReady || sharePushing}
                onClick={() =>
                  setSharing(sharing === `reference/${r.file}` ? null : `reference/${r.file}`)
                }
              />
            )}
            {groupOf(r.tier) !== 'built-in' && (
              <RowAction
                icon={Trash2}
                danger
                label={`${removeVerb} · ${r.file}`}
                title={removeVerb}
                onClick={() => void removeReference(r)}
              />
            )}
          </RowActions>
          {/* A reference has no enable switch, but it still reserves the slot — that is what
              keeps its icons in the same column as the skill rows it is interleaved with. */}
          <RowToggle />
        </SettingRow>
        {sharing === `reference/${r.file}` && (
          <SharePushDialog
            kind="reference"
            name={r.file}
            onClose={() => {
              setSharing(null)
              refreshShare()
            }}
            onBusyChange={setSharePushing}
          />
        )}
      </Fragment>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {onReviewProposals && (
        <ProposalsBanner
          types={LIBRARY_TYPES}
          noun="your library"
          onReview={() => onReviewProposals(LIBRARY_TYPES)}
        />
      )}
      {error && errorAlert(error)}
      <div className="flex items-center gap-2">
        <input
          aria-label="search library"
          placeholder="Search names and reference content…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // `bg-overlay`, not `bg-black/20` (Task 14): this search row sits directly on the
          // Settings page ground (SettingsView's content column, not a SettingsSection card) —
          // the ground-level on-page token, not the on-card `bg-well`.
          className="min-w-0 flex-1 rounded-r2 bg-overlay px-2 py-1 text-sm outline-none placeholder:text-faint"
        />
        <div
          role="group"
          aria-label="Filter kind"
          className="flex shrink-0 overflow-hidden rounded-r2 border border-hair"
        >
          {(['all', 'skill', 'reference'] as const).map((k) => (
            <button
              key={k}
              aria-label={`Filter kind · ${k}`}
              aria-pressed={kind === k}
              className={`px-2.5 py-1 text-xs transition-colors ${
                kind === k ? 'bg-signal/10 text-ink' : 'text-dim hover:text-ink'
              } ${k !== 'reference' ? 'border-r border-hair' : ''}`}
              onClick={() => setKind(k)}
            >
              {k === 'all' ? 'All' : k === 'skill' ? 'Skills' : 'References'}
            </button>
          ))}
        </div>
        <MenuButton
          variant="outline"
          align="right"
          aria-label="New"
          label="New"
          items={[
            {
              label: 'New skill',
              onSelect: () => openEditor({ kind: 'skill', name: 'my-skill', mode: 'create' })
            },
            {
              label: 'New reference',
              onSelect: () => openEditor({ kind: 'reference', name: 'my-notes.md', mode: 'create' })
            },
            {
              label: 'Import from Claude…',
              onSelect: () => setImporting(true)
            }
          ]}
        />
      </div>
      {GROUP_ORDER.map((g) => {
        const groupSkills = skills.filter((s) => groupOf(s.tier) === g && skillVisible(s))
        const groupRefs = references.filter((r) => groupOf(r.tier) === g && refVisible(r))
        const empty = groupSkills.length === 0 && groupRefs.length === 0
        if (empty && (filtering || !GROUP_EMPTY[g])) return null
        const isCollapsed = !filtering && collapsedGroups.has(g)
        return (
          <SettingsSection
            key={g}
            title={GROUP_TITLE[g]}
            subtitle={GROUP_SUBTITLE[g]}
            count={groupSkills.length + groupRefs.length}
            collapsed={isCollapsed}
            onToggle={
              filtering
                ? undefined
                : () =>
                    setCollapsedGroups((prev) => {
                      const next = new Set(prev)
                      if (next.has(g)) next.delete(g)
                      else next.add(g)
                      return next
                    })
            }
          >
            {empty && <div className="px-3 py-2 text-xs text-dim">{GROUP_EMPTY[g]}</div>}
            {groupSkills.map(skillRow)}
            {groupRefs.map(refRow)}
          </SettingsSection>
        )
      })}
      {filtering &&
        skills.every((s) => !skillVisible(s)) &&
        references.every((r) => !refVisible(r)) && (
          <div className="px-3 py-2 text-xs text-faint">No matches.</div>
        )}
      {viewer?.kind === 'skill' &&
        (() => {
          const s = skills.find((x) => x.name === viewer.name)
          return (
            <MarkdownViewer
              key={viewer.name}
              title={`skills / ${viewer.name}`}
              ariaLabel={`skill · ${viewer.name}`}
              load={() => window.argus.skills.read(viewer.name).then((r) => r.content)}
              onClose={() => setViewer(null)}
              showAuthorship
              extraActions={
                s && s.tier === 'hivemind' ? (
                  <Btn variant="outline" onClick={() => setForking(s)}>
                    <Pencil size={13} aria-hidden="true" />
                    Edit a copy
                  </Btn>
                ) : s && s.tier === 'bundled' ? (
                  <span className="text-xs text-dim">Read-only — {TIER_EXPLANATIONS.bundled}</span>
                ) : undefined
              }
            />
          )
        })()}
      {forking && (
        <ForkSkillDialog
          sourceName={forking.name}
          onCancel={() => setForking(null)}
          onConfirm={(newName) => doFork(forking, newName)}
        />
      )}
      {importing && <ImportSkillsDialog onClose={() => setImporting(false)} />}
      {viewer?.kind === 'reference' &&
        (() => {
          const r = references.find((x) => x.file === viewer.name)
          return (
            <RefViewer
              file={viewer.name}
              onClose={() => setViewer(null)}
              showAuthorship
              extraActions={
                r?.tier === 'hivemind' ? (
                  <Btn variant="outline" onClick={() => void claimThenEdit(r)}>
                    <Pencil size={13} aria-hidden="true" />
                    Edit a copy
                  </Btn>
                ) : undefined
              }
            />
          )
        })()}
    </div>
  )
}
