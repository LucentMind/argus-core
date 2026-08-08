import { useEffect, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { SettingsSection, SettingRow, FIELD, TEXTAREA_FIELD, SelectField } from './settingsLayout'
import { Btn, Checkbox, Chip, IconBtn } from '../ui'
import { confirm } from '../../lib/confirmStore'
import { chipStamp } from '../../lib/time'
import {
  MAX_TIMEOUT_MINUTES,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  type RoutineDef,
  type RoutineRunSummary,
  type RoutineSchedule,
  type RoutinesPayload
} from '../../../../shared/routines'

type ScheduleKind = 'manual' | 'interval' | 'daily' | 'weekly'

/**
 * Labels ARE the SelectField's values — it renders raw strings — so the mapping lives here in
 * one direction and is inverted on change. Kept free of ellipses and other punctuation so the
 * accessible name a test queries by is exactly what is written here.
 */
const SCHEDULE_LABELS: Record<ScheduleKind, string> = {
  manual: 'Manual only',
  interval: 'Every N minutes',
  daily: 'Daily',
  weekly: 'Weekly'
}
const SCHEDULE_KINDS = Object.keys(SCHEDULE_LABELS) as ScheduleKind[]
const SCHEDULE_OPTIONS = SCHEDULE_KINDS.map((k) => SCHEDULE_LABELS[k])

/** Index IS the value: 0 = Sunday, matching `Date.prototype.getDay()` and scheduleSchema. */
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * Per-kind defaults for a fresh schedule — NOT one shared value. Routines exist for work that
 * happens without a human present: Daily is the overnight-sweep case the feature was built for,
 * so it defaults into the small hours; Weekly is a weekday digest, so it defaults to the start of
 * the working day. Collapsing these into one constant would default a new Daily routine into the
 * middle of the morning — the opposite of what "Daily" is for here.
 */
const DAILY_DEFAULT_TIME = '02:00'
const WEEKLY_DEFAULT_TIME = '07:00'

/**
 * Derives a routine id from its name, inside `routineSchema`'s `/^[a-z0-9][a-z0-9-]{0,55}$/`.
 *
 * The 56-char cap is not cosmetic: the id is embedded in the run's case slug as `routine-<id>`,
 * and caseService's SLUG_RE tops out at 64. Trailing hyphens are stripped AFTER the slice too —
 * cutting mid-word can leave one, and `sweep-` is a legal-looking id that the schema rejects.
 */
function deriveId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/, '')
}

/** `null` while creating — an existing routine's id is fixed (see `saveDraft`). */
interface Draft {
  id: string | null
  name: string
  prompt: string
  model: string
  timeoutMinutes: string
  enabled: boolean
  /**
   * Carried through the editor untouched. `driverKind` has no field here (Increment 1 edits it
   * in config/routines.json), and `save` is a whole-object upsert — so a draft that forgot it
   * would silently move the routine back onto the default driver on the next name edit.
   */
  driverKind?: string
  /** Held as separate form state, like `timeoutMinutes` — assembled into a schedule on save. */
  scheduleKind: ScheduleKind
  everyMinutes: string
  /**
   * One field PER KIND, not a single `at` shared by both — that is what lets "switch kinds" and
   * "the user already typed a time" coexist without a separate touched flag. Each field starts at
   * that kind's default and is only ever written by the Time input while its own kind is
   * selected, so switching away and back always returns exactly what was there before: the
   * user's typed value if they touched it, the kind's default if they never did. `draftFrom`
   * seeds the field for the *stored* kind from the routine and leaves the other at its default,
   * since there is no stored value for a kind the routine isn't using.
   */
  dailyAt: string
  weeklyAt: string
  days: number[]
}

function draftFrom(r: RoutineDef): Draft {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    model: r.model ?? '',
    timeoutMinutes: String(r.timeoutMs / 60_000),
    enabled: r.enabled,
    ...(r.driverKind ? { driverKind: r.driverKind } : {}),
    scheduleKind: r.schedule?.kind ?? 'manual',
    everyMinutes: r.schedule?.kind === 'interval' ? String(r.schedule.everyMinutes) : '60',
    dailyAt: r.schedule?.kind === 'daily' ? r.schedule.at : DAILY_DEFAULT_TIME,
    weeklyAt: r.schedule?.kind === 'weekly' ? r.schedule.at : WEEKLY_DEFAULT_TIME,
    days: r.schedule?.kind === 'weekly' ? r.schedule.days : [1, 2, 3, 4, 5]
  }
}

const BLANK_DRAFT: Draft = {
  id: null,
  name: '',
  prompt: '',
  model: '',
  timeoutMinutes: '10',
  enabled: true,
  scheduleKind: 'manual',
  everyMinutes: '60',
  dailyAt: DAILY_DEFAULT_TIME,
  weeklyAt: WEEKLY_DEFAULT_TIME,
  days: [1, 2, 3, 4, 5]
}

/** `null` while a run is still in flight — the caller renders nothing rather than a fake 0s. */
function duration(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${ms}ms`
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return secs % 60 ? `${mins}m ${secs % 60}s` : `${mins}m`
  return mins % 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${Math.floor(mins / 60)}h`
}

/**
 * Four tones for four outcomes. `timeout` and `running` deliberately do NOT share a tone with
 * `failed`/`ok`: this list is the audit trail for unattended work, and a user scanning it is
 * asking "did my overnight work actually happen?" — a run that was cut off at its time limit,
 * and a run still going, are both wrong answers to read as a clean pass.
 */
const RUN_TONE: Record<RoutineRunSummary['status'], 'signal' | 'danger' | 'defect' | 'review'> = {
  ok: 'signal',
  failed: 'danger',
  timeout: 'defect',
  running: 'review'
}

/** Beyond this, a run's summary/error is cut and gets a toggle. */
const TRUNCATE_AT = 200

/**
 * A run's summary or error, truncated until asked for.
 *
 * Truncated in JS rather than by a `line-clamp` so the cut is real: an unattended run's final
 * text can be several paragraphs, and a CSS-only clamp would leave the whole thing in the DOM,
 * where no test in this suite (jsdom resolves no stylesheet) can tell readable from hidden.
 *
 * Module scope, not nested in the row: `react-hooks/static-components`, and a component
 * redeclared per render would drop its open/closed state on every payload refresh.
 */
function ExpandableText({
  text,
  kind
}: {
  text: string
  kind: 'summary' | 'error'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const long = text.length > TRUNCATE_AT
  return (
    <p className={kind === 'error' ? 'text-danger' : 'text-dim'}>
      <span className="whitespace-pre-wrap">
        {open || !long ? text : `${text.slice(0, TRUNCATE_AT)}…`}
      </span>
      {long && (
        <button
          type="button"
          className="ml-1.5 whitespace-nowrap text-mute underline transition-colors hover:text-ink"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </p>
  )
}

function RoutineEditor({
  draft,
  onChange,
  onSave,
  onCancel
}: {
  draft: Draft
  onChange: (d: Draft) => void
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  // On an existing routine the id is fixed: `save` upserts BY id, so re-deriving it from an
  // edited name would leave the old routine in place and add a second one beside it.
  const id = draft.id ?? deriveId(draft.name)
  return (
    // A bare child of the section Card, outside any SettingRow, so it carries its own padding
    // (same idiom as MemorySettings' MemoryEditor).
    <div className="flex flex-col gap-3 px-4 py-3">
      <label className="flex flex-col gap-1 text-xs text-dim">
        Name
        <input
          autoFocus
          className={FIELD}
          placeholder="e.g. Nightly crash sweep"
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </label>

      <p className="text-xs text-mute">
        id{' '}
        <code data-testid="routine-id" className="font-mono text-ink">
          {id || '—'}
        </code>
        {draft.id !== null && ' · fixed once created'} · runs land in case{' '}
        <span className="font-mono text-dim">routine-{id || '…'}</span>
      </p>

      <label className="flex flex-col gap-1 text-xs text-dim">
        Prompt
        <textarea
          className={TEXTAREA_FIELD}
          placeholder="What this routine should do, with no user present to answer questions."
          value={draft.prompt}
          onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
        />
      </label>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-dim">
          Model
          <input
            className={FIELD}
            placeholder="(driver default)"
            value={draft.model}
            onChange={(e) => onChange({ ...draft, model: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-dim">
          Timeout (minutes)
          <input
            type="number"
            min={1}
            // Increment 1 has no cancel, so an over-long turn holds the serial routine slot
            // until it ends on its own. `max` is only a nudge (a number input still accepts a
            // typed value above it) — saveDraft below and routineSchema are the real gates.
            max={MAX_TIMEOUT_MINUTES}
            className={`${FIELD} w-28`}
            value={draft.timeoutMinutes}
            onChange={(e) => onChange({ ...draft, timeoutMinutes: e.target.value })}
          />
        </label>
        <div className="pb-1.5">
          <Checkbox
            checked={draft.enabled}
            onChange={(v) => onChange({ ...draft, enabled: v })}
            label="Enabled"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-dim">
          Schedule
          <SelectField
            aria-label="Schedule"
            value={SCHEDULE_LABELS[draft.scheduleKind]}
            options={SCHEDULE_OPTIONS}
            onChange={(label) =>
              onChange({
                ...draft,
                scheduleKind: SCHEDULE_KINDS.find((k) => SCHEDULE_LABELS[k] === label) ?? 'manual'
              })
            }
          />
        </label>
        {draft.scheduleKind === 'interval' && (
          <label className="flex flex-col gap-1 text-xs text-dim">
            Minutes
            <input
              type="number"
              min={MIN_INTERVAL_MINUTES}
              max={MAX_INTERVAL_MINUTES}
              className={`${FIELD} w-28`}
              value={draft.everyMinutes}
              onChange={(e) => onChange({ ...draft, everyMinutes: e.target.value })}
            />
          </label>
        )}
        {draft.scheduleKind !== 'manual' && draft.scheduleKind !== 'interval' && (
          <label className="flex flex-col gap-1 text-xs text-dim">
            Time
            <input
              type="time"
              className={`${FIELD} w-32`}
              value={draft.scheduleKind === 'daily' ? draft.dailyAt : draft.weeklyAt}
              onChange={(e) =>
                onChange(
                  draft.scheduleKind === 'daily'
                    ? { ...draft, dailyAt: e.target.value }
                    : { ...draft, weeklyAt: e.target.value }
                )
              }
            />
          </label>
        )}
        {draft.scheduleKind === 'weekly' && (
          <div className="flex flex-col gap-1 text-xs text-dim">
            Days
            <div className="flex gap-1">
              {DAY_LABELS.map((label, day) => {
                const on = draft.days.includes(day)
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={on}
                    className={`rounded-r1 border px-2 py-1 text-[11px] transition-colors ${
                      on ? 'border-hair bg-hair/50 text-ink' : 'border-hair/50 text-mute'
                    }`}
                    onClick={() =>
                      onChange({
                        ...draft,
                        days: on
                          ? draft.days.filter((d) => d !== day)
                          : [...draft.days, day].sort((a, b) => a - b)
                      })
                    }
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
      <p className="text-xs text-mute">
        Scheduled routines run only while Argus is open. A run missed while it was closed starts
        once at the next launch.
      </p>

      <div className="flex items-center gap-2">
        <Btn variant="primary" onClick={onSave}>
          Save
        </Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
        <span className="text-xs text-mute">
          A disabled routine stays saved but refuses to run.
        </span>
      </div>
    </div>
  )
}

/**
 * Routines: saved prompts that run unattended in their own case, on demand (Increment 1).
 *
 * Three surfaces in one page — the definitions, the Run now control, and the run history that
 * says what each past run actually did. The history is the point: unattended work nobody watched
 * is only trustworthy if there is a record of it afterwards.
 */
export function RoutinesPage(): React.JSX.Element {
  const [payload, setPayload] = useState<RoutinesPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * Separate from `error`, which replaces the whole page. A failed save — or, far more often, a
   * `runNow` rejected because another run is already in flight — must not blank the list the
   * user is looking at.
   */
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Draft | null>(null)

  useEffect(() => {
    const reload = (): void => {
      window.argus.routines
        .list()
        .then(setPayload)
        .catch((e: Error) => setError(e.message))
    }
    reload()
    // Payload-free broadcast: runs start, finish and get reconciled in main, and another window
    // (or a hand-edit of config/routines.json) can change the definitions underneath this page.
    return window.argus.routines.onChanged(reload)
  }, [])

  async function runNow(id: string): Promise<void> {
    try {
      setPayload(await window.argus.routines.runNow(id))
      setMutationError(null)
    } catch (e) {
      // Expected, not exceptional: unknown / disabled / already-running all land here, and runs
      // are serial, so "already running" is the everyday case. Caught so it reads as a sentence
      // instead of an unhandled rejection in the console.
      setMutationError((e as Error).message)
    }
  }

  async function saveDraft(): Promise<void> {
    if (!editing) return
    const name = editing.name.trim()
    const prompt = editing.prompt.trim()
    const id = editing.id ?? deriveId(name)
    if (!id) {
      // Deliberately not "must contain a letter or digit": a Japanese or Cyrillic name is full of
      // letters and still derives nothing, because the id charset is ASCII-only. Say what the id
      // can hold, so the user knows what to add rather than doubting what they typed.
      setMutationError(
        'No id could be derived from this name — ids use only a–z, 0–9 and hyphens, and everything else (accents, other scripts, punctuation) is dropped. Add at least one plain letter or digit.'
      )
      return
    }
    // CREATE only — in edit mode replacing the routine under this id is the whole point.
    // `save` is a whole-object upsert keyed on id, so a colliding id overwrites the existing
    // routine's prompt and settings with no trace. Refusing rather than offering a confirm:
    // nothing in the form hints that "Morning Triage" and "morning triage" are the same routine
    // (nor that two long names sharing a 56-char prefix are), so an overwrite prompt would put a
    // one-click destruction of a prompt the user cannot see behind a surprise they did not
    // anticipate. Naming the routine in the way instead leaves both real intents reachable:
    // rename, or Edit the existing routine — which shows its prompt before touching it.
    if (editing.id === null) {
      const clash = payload?.routines.find((r) => r.id === id)
      if (clash) {
        setMutationError(
          `"${clash.name}" already uses the id ${id} — ids are derived from the name, so different names can produce the same one. Pick another name, or edit "${clash.name}" instead.`
        )
        return
      }
    }
    if (!prompt) {
      setMutationError(
        'A routine needs a prompt — it is what the unattended session is asked to do.'
      )
      return
    }
    const minutes = Number(editing.timeoutMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setMutationError('Timeout must be a positive number of minutes.')
      return
    }
    if (minutes > MAX_TIMEOUT_MINUTES) {
      setMutationError(
        `Timeout must be at most ${MAX_TIMEOUT_MINUTES} minutes — a run cannot be cancelled once it starts.`
      )
      return
    }
    const model = editing.model.trim()
    let schedule: RoutineSchedule | undefined
    if (editing.scheduleKind === 'interval') {
      const every = Number(editing.everyMinutes)
      if (!Number.isInteger(every) || every < MIN_INTERVAL_MINUTES) {
        setMutationError(
          `An interval schedule must be at least ${MIN_INTERVAL_MINUTES} minutes — runs are ` +
            `serial, and a shorter one would hold the single slot continuously.`
        )
        return
      }
      if (every > MAX_INTERVAL_MINUTES) {
        setMutationError(
          `An interval schedule must be at most ${MAX_INTERVAL_MINUTES} minutes (one week) — ` +
            `use Daily or Weekly for anything longer.`
        )
        return
      }
      schedule = { kind: 'interval', everyMinutes: every }
    } else if (editing.scheduleKind === 'daily' || editing.scheduleKind === 'weekly') {
      const at = editing.scheduleKind === 'daily' ? editing.dailyAt : editing.weeklyAt
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
        setMutationError('Pick a time in 24-hour HH:MM form.')
        return
      }
      if (editing.scheduleKind === 'daily') {
        schedule = { kind: 'daily', at }
      } else {
        if (editing.days.length === 0) {
          setMutationError('A weekly schedule needs at least one day.')
          return
        }
        schedule = { kind: 'weekly', days: [...editing.days].sort((a, b) => a - b), at }
      }
    }
    /**
     * The routine as stored, with this form's fields layered on top — NOT a fresh object built
     * from form state. `routineSchema` is a `looseObject`, so config/routines.json can carry keys
     * this editor knows nothing about — a hand-added key, or a future field this form does not
     * yet expose. Rebuilding from the form would drop every one of them on the next edit — the
     * same shape of loss as the `driverKind` defect already fixed here.
     */
    const base =
      editing.id === null ? undefined : payload?.routines.find((r) => r.id === editing.id)
    const def: RoutineDef = {
      ...base,
      id,
      name,
      prompt,
      timeoutMs: Math.round(minutes * 60_000),
      enabled: editing.enabled
    }
    // Optional fields are ASSIGNED OR DELETED, never conditionally spread: a spread only ever adds
    // keys, so a Model the user emptied would be resurrected from `base` and never clearable.
    if (editing.driverKind) def.driverKind = editing.driverKind
    else delete def.driverKind
    if (model) def.model = model
    else delete def.model
    if (schedule) def.schedule = schedule
    else delete def.schedule
    try {
      setPayload(await window.argus.routines.save(def))
      setMutationError(null)
      setEditing(null)
    } catch (e) {
      // Editor deliberately left open — closing it here would discard the edit that failed.
      setMutationError((e as Error).message)
    }
  }

  async function remove(r: RoutineDef): Promise<void> {
    const ok = await confirm({
      title: `Delete routine "${r.name}"?`,
      message:
        'The definition is removed. Its past runs stay in the history below, and the case they wrote to is left alone.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    try {
      setPayload(await window.argus.routines.remove(r.id))
      setMutationError(null)
      setEditing((cur) => (cur?.id === r.id ? null : cur))
    } catch (e) {
      setMutationError((e as Error).message)
    }
  }

  if (error) return <p className="p-3 text-xs text-danger">{error}</p>
  if (!payload) return <p className="p-3 text-xs text-mute">Loading…</p>

  const { routines, runs, runningId } = payload
  const nameOf = (routineId: string): string =>
    routines.find((r) => r.id === routineId)?.name ?? routineId

  return (
    <div className="flex flex-col gap-6">
      {mutationError && (
        <p
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 p-2 text-xs text-danger"
        >
          {mutationError}
        </p>
      )}
      {payload.loadError && (
        <p
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 p-2 text-xs text-danger"
        >
          config/routines.json could not be parsed — no routines are loaded. Saving here replaces
          the broken file. ({payload.loadError})
        </p>
      )}

      <SettingsSection
        title="Routines"
        subtitle="Saved prompts Argus runs unattended, each in its own case. Runs are serial — one at a time."
        action={
          <Btn onClick={() => setEditing({ ...BLANK_DRAFT })} disabled={editing?.id === null}>
            New routine
          </Btn>
        }
      >
        {routines.length === 0 && editing === null && (
          <div className="px-4 py-3 text-xs text-faint">
            No routines yet — add one to have Argus run a saved prompt on demand.
          </div>
        )}
        {routines.map((r) => {
          const running = runningId === r.id
          return (
            <div key={r.id}>
              <SettingRow
                label={r.name}
                description={r.prompt}
                badge={
                  <>
                    {!r.enabled && <Chip tone="neutral">disabled</Chip>}
                    {r.driverKind && <Chip tone="neutral">{r.driverKind}</Chip>}
                    {r.model && <Chip tone="neutral">{r.model}</Chip>}
                    <Chip tone="neutral">limit {Math.round(r.timeoutMs / 60_000)}m</Chip>
                  </>
                }
              >
                <Btn
                  aria-label={running ? `Running · ${r.name}` : `Run now · ${r.name}`}
                  // Every button, not just this row's: runs are serial, so while one is in
                  // flight the honest state of all of them is unavailable.
                  disabled={!r.enabled || runningId !== null}
                  onClick={() => void runNow(r.id)}
                >
                  {running ? 'Running…' : 'Run now'}
                </Btn>
                <IconBtn
                  aria-label={`edit · ${r.name}`}
                  title="Edit"
                  onClick={() => setEditing(draftFrom(r))}
                >
                  <Pencil size={14} />
                </IconBtn>
                <IconBtn
                  aria-label={`delete · ${r.name}`}
                  title="Delete"
                  onClick={() => void remove(r)}
                >
                  <Trash2 size={14} />
                </IconBtn>
              </SettingRow>
              {editing?.id === r.id && (
                <RoutineEditor
                  draft={editing}
                  onChange={setEditing}
                  onSave={() => void saveDraft()}
                  onCancel={() => setEditing(null)}
                />
              )}
            </div>
          )
        })}
        {editing?.id === null && (
          <RoutineEditor
            draft={editing}
            onChange={setEditing}
            onSave={() => void saveDraft()}
            onCancel={() => setEditing(null)}
          />
        )}
      </SettingsSection>

      <SettingsSection
        title="Recent runs"
        count={runs.length}
        subtitle="What each unattended run did, newest first — the record of work nobody watched happen."
      >
        {runs.length === 0 && (
          <div className="px-4 py-3 text-xs text-faint">
            No runs yet — Run now on a routine above starts one.
          </div>
        )}
        {/* Rendered in payload order: main hands these over newest-first (ORDER BY id DESC),
            capped at the 50 most recent. */}
        {runs.map((run) => {
          const took = duration(run.startedAt, run.finishedAt)
          return (
            <div key={run.id} className="flex items-start gap-3 px-4 py-2.5 text-xs">
              <Chip tone={RUN_TONE[run.status]}>
                <span data-testid={`run-status-${run.id}`}>{run.status}</span>
              </Chip>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {/* Name plus where the work landed, in one line (PromptsDevPage's capture rows
                    use the same `a · b` shape). The routine may have been deleted since, so the
                    raw id is the fallback — a run with no label at all is unreadable history. */}
                <span data-testid={`run-routine-${run.id}`} className="truncate text-ink">
                  {nameOf(run.routineId)} · {run.caseSlug}
                </span>
                {run.error && <ExpandableText text={run.error} kind="error" />}
                {run.summary && <ExpandableText text={run.summary} kind="summary" />}
                {!run.error && !run.summary && (
                  <p className="text-faint">
                    {run.status === 'running' ? 'in progress…' : 'no output recorded'}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[10px] text-faint">
                <span data-testid={`run-started-${run.id}`}>{chipStamp(run.startedAt)}</span>
                {took && <span data-testid={`run-duration-${run.id}`}>took {took}</span>}
              </div>
            </div>
          )
        })}
      </SettingsSection>
    </div>
  )
}
