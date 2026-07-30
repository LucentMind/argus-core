import { useEffect, useState, Fragment } from 'react'
import { HandGrab, Share2, Trash2 } from 'lucide-react'
import { SettingsSection, SettingRow, Switch } from './settingsLayout'
import { Btn, Chip } from '../ui'
import { ProposalsBanner } from './ProposalsBanner'
import { SharePushDialog, PushReceiptChip } from './SharePushDialog'
import { useSharePush } from './useSharePush'
import { RefViewer, MarkdownViewer } from '../references/RefViewer'
import { TierBadge } from './TierBadge'
import { accessStore } from '../../lib/accessStore'
import { confirm } from '../../lib/confirmStore'
import { useRefSyncPayload } from '../../lib/referenceSyncStore'
import { PUSHABLE_TIERS, HIVE_MANAGED_TIERS, TIER_LABELS } from '../../../../shared/trustTiers'
import type { TrustTier } from '../../../../shared/trustTiers'
import type { SkillListItem } from '../../../../shared/memoryIpc'
import type { ReferenceStatus } from '../../../../shared/referenceSync'
import type { SkillUsageRow, ReferenceUsageRow } from '../../../../shared/observability'
import type { ProposalType } from '../../../../shared/proposals'

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
  'built-in': 'Ships with an installed pack.'
}
/** Teaching empty states. Groups without an entry are hidden when empty. */
const GROUP_EMPTY: Partial<Record<GroupId, string>> = {
  yours: "Nothing yet — accept an agent proposal, or claim something from your team's HiveMind.",
  subscribed: "Nothing subscribed — browse your team's HiveMind under Settings → Team."
}

/** Collapses its destructive child to 0 width until the row is hovered or focused (spec §3). */
function Reveal({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="-mr-2 flex w-0 items-center overflow-hidden opacity-0 transition-opacity group-hover/row:mr-0 group-hover/row:w-auto group-hover/row:opacity-100 group-focus-within/row:mr-0 group-focus-within/row:w-auto group-focus-within/row:opacity-100">
      {children}
    </span>
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
            'Your local copy in skills-user is deleted and the downloaded HiveMind skill takes over.',
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
    // a failed initial load would otherwise leave the page on "loading…" forever
    if (error) return errorAlert(error)
    return <div className="text-dim">loading…</div>
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
          description={s.description}
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
          {s.tier === 'user' && (
            <>
              <Reveal>
                <Btn
                  variant={adopt ? 'outline' : 'dangerSolid'}
                  aria-label={`${adopt ? 'Adopt upstream' : 'Delete'} · ${s.name}`}
                  onClick={() => void removeUserSkill(s, adopt)}
                >
                  {!adopt && <Trash2 size={13} aria-hidden="true" />}
                  {adopt ? 'Adopt upstream' : 'Delete'}
                </Btn>
              </Reveal>
              <Btn
                variant="outline"
                aria-label={`Share ${s.name} to HiveMind`}
                title={shareTip}
                // sharePushing: opening another row's dialog would unmount an
                // in-flight push and its PR URL would never be shown
                disabled={!shareReady || sharePushing}
                onClick={() => setSharing(sharing === `skill/${s.name}` ? null : `skill/${s.name}`)}
              >
                <Share2 size={13} aria-hidden="true" />
                Share
              </Btn>
            </>
          )}
          {s.tier === 'hivemind' && (
            <Reveal>
              <Btn
                variant="dangerSolid"
                aria-label={`Remove · ${s.name}`}
                onClick={() => void removeHiveSkill(s)}
              >
                <Trash2 size={13} aria-hidden="true" />
                Remove
              </Btn>
            </Reveal>
          )}
          <Switch
            checked={s.enabled}
            onChange={(v) => void toggle(s, v)}
            aria-label={`enabled · ${s.tier}/${s.name}`}
          />
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
    return (
      <Fragment key={`reference/${r.file}`}>
        <SettingRow
          label={r.file}
          onOpen={() => setViewer({ kind: 'reference', name: r.file })}
          description={
            <>
              {r.lastSynced ? `last synced ${r.lastSynced.slice(0, 10)}` : 'never synced'}
              {u && (
                <>
                  {' · '}
                  {u.readCount === 0
                    ? 'never read'
                    : `${u.readCount} reads · last ${u.lastReadAt!.slice(0, 10)}`}
                </>
              )}
            </>
          }
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
          {canClaim && (
            <Btn
              variant="outline"
              aria-label={`Claim · ${r.file}`}
              title="Make this yours — editable, deletable, shareable"
              onClick={() => void claimReference(r)}
            >
              <HandGrab size={13} aria-hidden="true" />
              Claim
            </Btn>
          )}
          {groupOf(r.tier) !== 'built-in' && (
            <Reveal>
              <Btn
                variant="dangerSolid"
                aria-label={`${r.tier !== 'hivemind' && r.tier !== 'confluence' ? 'Delete' : 'Remove'} · ${r.file}`}
                onClick={() => void removeReference(r)}
              >
                <Trash2 size={13} aria-hidden="true" />
                {r.tier !== 'hivemind' && r.tier !== 'confluence' ? 'Delete' : 'Remove'}
              </Btn>
            </Reveal>
          )}
          {canShare && (
            <Btn
              variant="outline"
              aria-label={`Share ${r.file} to HiveMind`}
              title={shareTip}
              // sharePushing: opening another row's dialog would unmount an
              // in-flight push and its PR URL would never be shown
              disabled={!shareReady || sharePushing}
              onClick={() =>
                setSharing(sharing === `reference/${r.file}` ? null : `reference/${r.file}`)
              }
            >
              <Share2 size={13} aria-hidden="true" />
              Share
            </Btn>
          )}
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
          className="min-w-0 flex-1 rounded-r2 bg-black/20 px-2 py-1 text-sm outline-none placeholder:text-faint"
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
      {viewer?.kind === 'reference' && (
        <RefViewer file={viewer.name} onClose={() => setViewer(null)} />
      )}
      {viewer?.kind === 'skill' && (
        <MarkdownViewer
          key={viewer.name}
          title={`skills / ${viewer.name}`}
          ariaLabel={`skill · ${viewer.name}`}
          load={() => window.argus.skills.read(viewer.name).then((r) => r.content)}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  )
}
