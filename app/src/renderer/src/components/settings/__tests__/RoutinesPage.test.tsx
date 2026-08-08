// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { RoutinesPage } from '../RoutinesPage'
import { chipStamp } from '../../../lib/time'
import type { RoutineDef, RoutineRunSummary, RoutinesPayload } from '../../../../../shared/routines'

// Same idiom as PromptsDevPage.test: confirmStore renders <ConfirmHost/> at the app root, which
// is not mounted here, so an unstubbed confirm() would hang the delete path forever.
vi.mock('../../../lib/confirmStore', async (orig) => ({
  ...(await orig<typeof import('../../../lib/confirmStore')>()),
  confirm: vi.fn(async () => true)
}))

const sweep: RoutineDef = {
  id: 'sweep',
  name: 'Nightly sweep',
  prompt: 'Sweep the repo for new crashes',
  timeoutMs: 600_000,
  enabled: true
}

function run(over: Partial<RoutineRunSummary> = {}): RoutineRunSummary {
  return {
    id: 1,
    routineId: 'sweep',
    caseSlug: 'routine-sweep',
    sessionId: 7,
    trigger: 'manual',
    status: 'ok',
    startedAt: '2026-08-03T02:00:00.000Z',
    finishedAt: '2026-08-03T02:05:00.000Z',
    summary: 'nothing new',
    error: null,
    ...over
  }
}

function payload(over: Partial<RoutinesPayload> = {}): RoutinesPayload {
  return {
    routines: [sweep],
    loadError: null,
    runningId: null,
    queued: [],
    nextRunAt: {},
    // Newest-first, exactly as listRoutineRuns hands them over (ORDER BY id DESC).
    runs: [
      run({ id: 2 }),
      run({
        id: 1,
        routineId: 'gone-routine',
        caseSlug: 'routine-gone-routine',
        status: 'failed',
        summary: null,
        error: 'driver exploded'
      })
    ],
    ...over
  }
}

interface RoutinesApi {
  list: Mock
  save: Mock
  remove: Mock
  runNow: Mock
  onChanged: Mock
}
let api: RoutinesApi

function stubApi(p: RoutinesPayload = payload()): void {
  api = {
    list: vi.fn(async () => p),
    save: vi.fn(async () => p),
    remove: vi.fn(async () => p),
    runNow: vi.fn(async () => ({ ...p, runningId: 'sweep' })),
    onChanged: vi.fn(() => () => {})
  }
  ;(window as unknown as { argus: unknown }).argus = { routines: api }
}

beforeEach(() => {
  stubApi()
})

describe('RoutinesPage — definitions', () => {
  it('lists the saved routines', async () => {
    render(<RoutinesPage />)
    expect(await screen.findByText('Nightly sweep')).toBeInTheDocument()
    expect(screen.getByText(/Sweep the repo for new crashes/)).toBeInTheDocument()
  })

  it('explains an empty list instead of rendering nothing', async () => {
    stubApi(payload({ routines: [], runs: [] }))
    render(<RoutinesPage />)
    expect(await screen.findByText(/No routines yet/i)).toBeInTheDocument()
  })

  it('surfaces a load failure instead of rendering an empty page', async () => {
    api.list = vi.fn(async () => {
      throw new Error('routines are unavailable')
    })
    render(<RoutinesPage />)
    expect(await screen.findByText(/routines are unavailable/)).toBeInTheDocument()
    expect(screen.queryByText('Nightly sweep')).not.toBeInTheDocument()
  })

  it('surfaces a malformed routines.json instead of silently showing an empty list', async () => {
    stubApi(payload({ routines: [], loadError: 'Unexpected token } in JSON at position 12' }))
    render(<RoutinesPage />)
    expect(await screen.findByText(/routines.json/i)).toBeInTheDocument()
    expect(screen.getByText(/Unexpected token/)).toBeInTheDocument()
  })

  it('re-reads the payload when the change broadcast fires', async () => {
    render(<RoutinesPage />)
    await screen.findByText('Nightly sweep')

    const reread = vi.fn(async () =>
      payload({ routines: [{ ...sweep, name: 'Renamed by another window' }] })
    )
    api.list = reread
    const onBroadcast = api.onChanged.mock.calls[0][0] as () => void
    onBroadcast()

    await waitFor(() => expect(reread).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Renamed by another window')).toBeInTheDocument()
  })

  it('unsubscribes from the broadcast on unmount', async () => {
    const unsubscribe = vi.fn()
    api.onChanged = vi.fn(() => unsubscribe)
    const { unmount } = render(<RoutinesPage />)
    await screen.findByText('Nightly sweep')
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('RoutinesPage — running on demand', () => {
  it('Run now calls the API and reflects the running state', async () => {
    render(<RoutinesPage />)
    await screen.findByText('Nightly sweep')
    fireEvent.click(screen.getByRole('button', { name: /run now/i }))
    await waitFor(() => expect(api.runNow).toHaveBeenCalledWith('sweep'))
    // The adopted payload carries runningId — the button must say so and stop accepting clicks,
    // because a second start is exactly what main rejects.
    const busy = await screen.findByRole('button', { name: /running/i })
    expect(busy).toBeDisabled()
  })

  it('surfaces a runNow rejection inline without replacing the page', async () => {
    api.runNow.mockRejectedValueOnce(new Error('A routine is already running'))
    render(<RoutinesPage />)
    await screen.findByText('Nightly sweep')
    fireEvent.click(screen.getByRole('button', { name: /run now/i }))
    expect(await screen.findByText(/already running/)).toBeInTheDocument()
    // The list must stay on screen — the common rejection is "another run is in flight", which
    // is not a reason to blank what the user was looking at.
    expect(screen.getByText('Nightly sweep')).toBeInTheDocument()
  })

  it('does not offer Run now for a disabled routine', async () => {
    stubApi(payload({ routines: [{ ...sweep, enabled: false }] }))
    render(<RoutinesPage />)
    await screen.findByText('Nightly sweep')
    expect(screen.getByRole('button', { name: /run now/i })).toBeDisabled()
    expect(screen.getByText(/disabled/i)).toBeInTheDocument()
  })
})

describe('RoutinesPage — editing', () => {
  it('creates a routine, deriving a valid id from the name', async () => {
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /new routine/i }))
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Morning Triage!' }
    })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'triage it' } })
    fireEvent.change(screen.getByLabelText('Timeout (minutes)'), { target: { value: '20' } })
    // Shown read-only so the user can see the slug their case folder will carry.
    expect(screen.getByTestId('routine-id')).toHaveTextContent('morning-triage')

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        id: 'morning-triage',
        name: 'Morning Triage!',
        prompt: 'triage it',
        timeoutMs: 1_200_000,
        enabled: true
      })
    )
  })

  it('refuses to save a name that derives no usable id', async () => {
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /new routine/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '!!!' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(/only a–z, 0–9 and hyphens/i)).toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('tells the truth about the id charset for a name that is all non-ASCII letters', async () => {
    // 日次巡回 is nothing BUT letters, and still derives an empty id. A message claiming the name
    // needs "a letter or digit" would be flatly wrong here and leave the user with no next step.
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /new routine/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '日次巡回' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    const msg = await screen.findByRole('alert')
    expect(msg).toHaveTextContent(/only a–z, 0–9 and hyphens/i)
    expect(msg).not.toHaveTextContent(/must contain at least one letter/i)
    expect(api.save).not.toHaveBeenCalled()
  })

  it('refuses to create a routine whose derived id collides with an existing one', async () => {
    // `save` is a whole-object upsert keyed on id, so going through here would replace the
    // existing routine's prompt and settings outright. Nothing in the form hints that "Sweep"
    // and "Nightly sweep" (id `sweep`) are the same routine.
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /new routine/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sweep' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a different job' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText(/already uses the id sweep/i)).toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
    // Mutation-tier error: the list the user was looking at must survive it.
    expect(screen.getByText('Nightly sweep')).toBeInTheDocument()
  })

  it('catches a collision two long names produce only after the 56-char id truncation', async () => {
    // Both names are visibly different; their ids are identical because deriveId slices at 56.
    stubApi(
      payload({ routines: [{ ...sweep, id: 'a'.repeat(56), name: `${'a'.repeat(60)} one` }] })
    )
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /new routine/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: `${'a'.repeat(58)} two` } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText(/already uses the id a{56}/i)).toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('still lets an edit replace the routine it is editing', async () => {
    // The collision guard is create-only — an edit legitimately overwrites its own id.
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /edit · Nightly sweep/i }))
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'sweep harder' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sweep', prompt: 'sweep harder' })
      )
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('preserves keys the editor knows nothing about', async () => {
    // routineSchema is a looseObject, so a hand-added (or Increment 2) key survives the store.
    // An editor that rebuilt the routine from its own fields would drop it on every save.
    stubApi(payload({ routines: [{ ...sweep, customField: 'custom-value' }] }))
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /edit · Nightly sweep/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nightly sweep v2' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Nightly sweep v2', customField: 'custom-value' })
      )
    )
  })

  it('clearing the model drops it instead of resurrecting the stored one', async () => {
    // The other half of preserving unknown keys: layering the form over the stored routine must
    // not make an emptied optional field un-clearable.
    stubApi(payload({ routines: [{ ...sweep, model: 'gpt-5-codex' }] }))
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /edit · Nightly sweep/i }))
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.save).toHaveBeenCalled())
    expect(api.save.mock.calls[0][0]).not.toHaveProperty('model')
  })

  it('saves a model typed into the editor', async () => {
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /edit · Nightly sweep/i }))
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '  claude-opus-4-6  ' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        // Trimmed: a model slug with stray whitespace is not a model the driver can resolve.
        expect.objectContaining({ id: 'sweep', model: 'claude-opus-4-6' })
      )
    )
  })

  it('toggles enabled off and saves it', async () => {
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /edit · Nightly sweep/i }))
    const box = screen.getByLabelText('Enabled')
    expect(box).toBeChecked()
    fireEvent.click(box)
    expect(box).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sweep', enabled: false })
      )
    )
  })

  it('refuses to save a timeout above the cap, naming the limit', async () => {
    // Increment 1 has no cancel: once a run starts, the only thing that ends it is the turn
    // completing or the timeout firing. With `min={1}` and no ceiling the user was one keystroke
    // ('600') from a ten-hour run holding the serial routine slot. The number input's `max` is
    // only a nudge — a typed value sails past it — so this is the gate that matters.
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /new routine/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Runaway' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText('Timeout (minutes)'), { target: { value: '600' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(/at most 120 minutes/i)).toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('saves a timeout exactly at the cap', async () => {
    // The boundary itself must remain usable — an off-by-one on the guard would make the
    // largest legal value unsaveable, and the test above would not notice.
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /new routine/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Long one' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText('Timeout (minutes)'), { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 7_200_000 }))
    )
  })

  it('refuses to save an empty prompt', async () => {
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /new routine/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sweep two' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(/needs a prompt/i)).toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('keeps the id stable and preserves fields the editor does not expose', async () => {
    // driverKind has no field in this editor. Re-deriving the id from an edited name would
    // create a SECOND routine instead of updating this one (save is an upsert by id), and
    // dropping driverKind would silently move the routine onto the default driver.
    stubApi(
      payload({ routines: [{ ...sweep, driverKind: 'github-copilot', model: 'gpt-5-codex' }] })
    )
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /edit · Nightly sweep/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nightly sweep v2' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        id: 'sweep',
        name: 'Nightly sweep v2',
        prompt: 'Sweep the repo for new crashes',
        timeoutMs: 600_000,
        enabled: true,
        driverKind: 'github-copilot',
        model: 'gpt-5-codex'
      })
    )
  })

  it('shows the driver and model a routine is pinned to', async () => {
    stubApi(
      payload({ routines: [{ ...sweep, driverKind: 'github-copilot', model: 'gpt-5-codex' }] })
    )
    render(<RoutinesPage />)
    await screen.findByText('Nightly sweep')
    expect(screen.getByText('github-copilot')).toBeInTheDocument()
    expect(screen.getByText('gpt-5-codex')).toBeInTheDocument()
  })

  it('surfaces a failed save inline and keeps the editor open', async () => {
    api.save = vi.fn(async () => {
      throw new Error('routines.json is read-only')
    })
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /edit · Nightly sweep/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(/read-only/)).toBeInTheDocument()
    // The draft must survive — a failed save that closed the editor would discard the edit.
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
  })

  it('deletes a routine after confirmation', async () => {
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /delete · Nightly sweep/i }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('sweep'))
  })

  it('does not delete when the confirm is declined', async () => {
    const { confirm } = await import('../../../lib/confirmStore')
    ;(confirm as Mock).mockResolvedValueOnce(false)
    render(<RoutinesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /delete · Nightly sweep/i }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(api.remove).not.toHaveBeenCalled()
  })
})

describe('RoutinesPage — schedule editor', () => {
  const openEditor = async (): Promise<void> => {
    render(<RoutinesPage />)
    await screen.findByText('Nightly sweep')
    fireEvent.click(screen.getByRole('button', { name: 'edit · Nightly sweep' }))
  }
  const pickKind = (label: string): void => {
    fireEvent.click(screen.getByRole('combobox', { name: 'Schedule' }))
    fireEvent.click(screen.getByRole('option', { name: label }))
  }
  const savedDef = (): RoutineDef => api.save.mock.calls[0][0] as RoutineDef

  it('saves a daily schedule', async () => {
    await openEditor()
    pickKind('Daily')
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '02:30' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.save).toHaveBeenCalled())
    expect(savedDef().schedule).toEqual({ kind: 'daily', at: '02:30' })
  })

  it('saves an interval schedule', async () => {
    await openEditor()
    pickKind('Every N minutes')
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '240' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.save).toHaveBeenCalled())
    expect(savedDef().schedule).toEqual({ kind: 'interval', everyMinutes: 240 })
  })

  it('saves a weekly schedule with the days that are toggled on', async () => {
    await openEditor()
    pickKind('Weekly')
    // The default is Mon–Fri; turn Wednesday off.
    fireEvent.click(screen.getByRole('button', { name: 'Wed' }))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.save).toHaveBeenCalled())
    expect(savedDef().schedule).toEqual({ kind: 'weekly', days: [1, 2, 4, 5], at: '07:00' })
  })

  it('round-trips an existing schedule into the editor', async () => {
    stubApi(payload({ routines: [{ ...sweep, schedule: { kind: 'daily', at: '05:15' } }] }))
    await openEditor()
    expect(screen.getByRole('combobox', { name: 'Schedule' })).toHaveTextContent('Daily')
    expect(screen.getByLabelText('Time')).toHaveValue('05:15')
  })

  it('round-trips an existing weekly schedule’s stored time unchanged', async () => {
    // The weekly default is 07:00 — this stored routine deliberately uses a different time, so a
    // draftFrom that defaulted instead of round-tripping would pass unnoticed.
    stubApi(
      payload({ routines: [{ ...sweep, schedule: { kind: 'weekly', days: [1, 3], at: '09:45' } }] })
    )
    await openEditor()
    expect(screen.getByRole('combobox', { name: 'Schedule' })).toHaveTextContent('Weekly')
    expect(screen.getByLabelText('Time')).toHaveValue('09:45')
  })

  it('defaults a fresh daily schedule to 02:00, the overnight-work case the feature is for', async () => {
    await openEditor()
    pickKind('Daily')
    expect(screen.getByLabelText('Time')).toHaveValue('02:00')
  })

  it('defaults a fresh weekly schedule to 07:00, the start of the working day', async () => {
    await openEditor()
    pickKind('Weekly')
    expect(screen.getByLabelText('Time')).toHaveValue('07:00')
  })

  it('keeps a typed time when the schedule kind is switched away and back', async () => {
    await openEditor()
    pickKind('Daily')
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '03:15' } })
    pickKind('Weekly')
    // Weekly's own default, untouched by the Daily edit above.
    expect(screen.getByLabelText('Time')).toHaveValue('07:00')
    pickKind('Daily')
    // The typed value survived the round trip through another kind — not silently overwritten.
    expect(screen.getByLabelText('Time')).toHaveValue('03:15')
  })

  it('clears the schedule when switched back to manual', async () => {
    stubApi(payload({ routines: [{ ...sweep, schedule: { kind: 'daily', at: '05:15' } }] }))
    await openEditor()
    pickKind('Manual only')
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(api.save).toHaveBeenCalled())
    // DELETED, not merely absent from the form's own object: `saveDraft` layers onto the stored
    // routine, so a spread-only update would resurrect the old schedule forever.
    expect('schedule' in savedDef()).toBe(false)
  })

  it('refuses an interval under the floor without closing the editor', async () => {
    await openEditor()
    pickKind('Every N minutes')
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(/at least 5 minutes/i)).toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
    // The editor stays open, so the rejected value is still there to correct.
    expect(screen.getByLabelText('Minutes')).toBeInTheDocument()
  })

  it('refuses a weekly schedule with no days selected', async () => {
    await openEditor()
    pickKind('Weekly')
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
      fireEvent.click(screen.getByRole('button', { name: d }))
    }
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(/at least one day/i)).toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
  })
})

describe('RoutinesPage — run history', () => {
  it('shows what each run did, when it started and how long it took', async () => {
    render(<RoutinesPage />)
    await screen.findByText('Nightly sweep')
    expect(screen.getByText('nothing new')).toBeInTheDocument()
    expect(screen.getByTestId('run-started-2')).toHaveTextContent(
      chipStamp('2026-08-03T02:00:00.000Z')
    )
    expect(screen.getByTestId('run-duration-2')).toHaveTextContent('5m')
  })

  it('shows the error for a failed run', async () => {
    render(<RoutinesPage />)
    await screen.findByText('Nightly sweep')
    expect(screen.getByText(/driver exploded/)).toBeInTheDocument()
  })

  it('names the routine a run belongs to, falling back to the raw id when it is gone', async () => {
    render(<RoutinesPage />)
    await screen.findByText('Nightly sweep')
    expect(screen.getByTestId('run-routine-2')).toHaveTextContent('Nightly sweep')
    expect(screen.getByTestId('run-routine-1')).toHaveTextContent('gone-routine')
  })

  it('gives ok, failed, timeout and running visually distinct pills', async () => {
    // The audit trail's whole job is answering "did my overnight work actually happen?" — a
    // timeout that renders identically to a clean ok answers it wrongly.
    stubApi(
      payload({
        runningId: 'sweep',
        runs: [
          run({ id: 4, status: 'running', finishedAt: null, summary: null }),
          run({ id: 3, status: 'timeout', summary: 'got half way', error: 'timed out after 10m' }),
          run({ id: 2, status: 'failed', summary: null, error: 'boom' }),
          run({ id: 1, status: 'ok' })
        ]
      })
    )
    render(<RoutinesPage />)
    await screen.findByTestId('run-status-1')
    const tones = [1, 2, 3, 4].map(
      // The testid sits on a span INSIDE the Chip, so the chip element is the parent — `closest`
      // would match the testid span itself and compare four identical class strings.
      (id) => screen.getByTestId(`run-status-${id}`).parentElement!.className
    )
    expect(new Set(tones).size).toBe(4)
  })

  it('a still-running run reports no duration', async () => {
    stubApi(
      payload({
        runningId: 'sweep',
        runs: [run({ id: 4, status: 'running', finishedAt: null, summary: null })]
      })
    )
    render(<RoutinesPage />)
    expect(await screen.findByTestId('run-status-4')).toHaveTextContent('running')
    expect(screen.queryByTestId('run-duration-4')).not.toBeInTheDocument()
  })

  it('truncates a long summary until it is expanded', async () => {
    const long = `start ${'x'.repeat(400)} end`
    stubApi(payload({ runs: [run({ id: 2, summary: long })] }))
    render(<RoutinesPage />)
    // Truncated in JS, not by a CSS line-clamp: jsdom resolves no stylesheet, so a clamp-only
    // implementation would leave this assertion passing on text nobody can read.
    expect(await screen.findByText(/start x+…$/)).toBeInTheDocument()
    expect(screen.queryByText(long)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show more/i }))
    expect(await screen.findByText(long)).toBeInTheDocument()
  })

  it('explains an empty history instead of rendering nothing', async () => {
    stubApi(payload({ runs: [] }))
    render(<RoutinesPage />)
    expect(await screen.findByText(/No runs yet/i)).toBeInTheDocument()
  })
})

describe('RoutinesPage — schedule status', () => {
  it('shows the next run for a scheduled routine', async () => {
    stubApi(payload({ nextRunAt: { sweep: '2026-08-09T02:00:00.000Z' } }))
    render(<RoutinesPage />)
    // chipStamp renders LOCAL time, so assert through it rather than a hardcoded string — this
    // suite runs under whatever timezone the machine or CI happens to have.
    expect(await screen.findByTestId('next-run-sweep')).toHaveTextContent(
      chipStamp('2026-08-09T02:00:00.000Z')
    )
  })

  it('says manual only for a routine with no next run', async () => {
    stubApi(payload({ nextRunAt: { sweep: null } }))
    render(<RoutinesPage />)
    expect(await screen.findByTestId('next-run-sweep')).toHaveTextContent(/manual only/i)
  })

  it('marks the running and queued rows, and leaves an idle routine runnable', async () => {
    const digest: RoutineDef = { ...sweep, id: 'digest', name: 'Weekly digest' }
    const audit: RoutineDef = { ...sweep, id: 'audit', name: 'Dep audit' }
    stubApi(
      payload({
        routines: [sweep, digest, audit],
        runningId: 'sweep',
        queued: ['digest'],
        nextRunAt: { sweep: null, digest: null, audit: null }
      })
    )
    render(<RoutinesPage />)
    expect(await screen.findByTestId('next-run-sweep')).toHaveTextContent(/running now/i)
    expect(screen.getByTestId('next-run-digest')).toHaveTextContent(/queued/i)
    // Increment 1 disabled EVERY Run now while any run was in flight, because a second click
    // could only throw. A click now joins the queue, so an idle routine's button is honestly
    // enabled — and a routine already queued still is not.
    expect(screen.getByRole('button', { name: 'Run now · Dep audit' })).toBeEnabled()
    // The accessible name tracks the visible state. A queued button reading "Run now" told a
    // screen-reader user the opposite of what the button says and does.
    expect(screen.getByRole('button', { name: 'Queued · Weekly digest' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Running · Nightly sweep' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Run now · Weekly digest' })).toBeNull()
  })

  it('badges each run with what triggered it', async () => {
    stubApi(
      payload({
        runs: [
          run({ id: 3, trigger: 'catchup' }),
          run({ id: 2, trigger: 'scheduled' }),
          run({ id: 1, trigger: 'manual' })
        ]
      })
    )
    render(<RoutinesPage />)
    expect(await screen.findByTestId('run-trigger-3')).toHaveTextContent('catch-up')
    expect(screen.getByTestId('run-trigger-2')).toHaveTextContent('scheduled')
    // Manual is the unremarkable case and gets no badge — a badge on every row is no signal.
    expect(screen.queryByTestId('run-trigger-1')).toBeNull()
  })
})
