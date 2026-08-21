// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RcaTemplateSettings } from '../RcaTemplateSettings'
import { confirm } from '../../../lib/confirmStore'
import { DEFAULT_RCA_TEMPLATE } from '../../../../../shared/rcaTemplate'
import type { RcaTemplate } from '../../../../../shared/rcaTemplate'

vi.mock('../../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

const patch = vi.fn()
vi.mock('../../../lib/settingsStore', async () => {
  const actual = await vi.importActual('../../../lib/settingsStore')
  return { ...actual, settingsStore: { patch: (p: unknown) => patch(p) } }
})

/**
 * Render with the editor already disclosed. The whole template is one collapsed row and only
 * ONE report is expanded at a time (2026-08-21 rework), so a test that wants to touch a row
 * has to open its way in — `fireEvent`, not `userEvent`, so the synchronous `act()` tests at
 * the bottom of this file can use the same helper.
 */
function renderWith(
  template: RcaTemplate = DEFAULT_RCA_TEMPLATE,
  report: 'exec' | 'tech' = 'exec'
): void {
  render(<RcaTemplateSettings template={template} />)
  fireEvent.click(screen.getByLabelText('Expand report template'))
  if (report === 'tech') fireEvent.click(screen.getByLabelText('Toggle the technical report'))
}

/** Open one section's instruction textarea — hidden until its pencil is clicked. */
function openInstruction(name: string): void {
  fireEvent.click(screen.getByLabelText('Edit the instruction for ' + name))
}

beforeEach(() => {
  patch.mockReset()
  vi.mocked(confirm).mockClear().mockResolvedValue(true)
})

describe('RcaTemplateSettings', () => {
  it('lists the open report sections in order, one report at a time', () => {
    renderWith()
    const exec = screen.getByRole('list', { name: /executive summary sections/i })
    expect(
      within(exec)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toHaveLength(5)
    // The other report is a shut header until asked for — the point of the rework, so it is
    // asserted rather than assumed.
    expect(screen.queryByRole('list', { name: /technical report sections/i })).toBeNull()
    fireEvent.click(screen.getByLabelText('Toggle the technical report'))
    expect(screen.getByRole('list', { name: /technical report sections/i })).toBeTruthy()
    expect(screen.queryByRole('list', { name: /executive summary sections/i })).toBeNull()
  })

  it('keeps the whole editor shut until its row is expanded', () => {
    render(<RcaTemplateSettings template={DEFAULT_RCA_TEMPLATE} />)
    expect(screen.queryByRole('list', { name: /executive summary sections/i })).toBeNull()
    // The collapsed row still says what it holds.
    expect(screen.getByText(/5 \+ 7 sections/)).toBeTruthy()
  })

  it('renames a section heading', async () => {
    renderWith()
    const field = screen.getByLabelText('Heading for What happened in the executive summary')
    await userEvent.clear(field)
    await userEvent.type(field, 'Summary')
    await userEvent.tab()
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        rca: expect.objectContaining({
          template: expect.objectContaining({
            exec: expect.arrayContaining([expect.objectContaining({ heading: 'Summary' })])
          })
        })
      })
    )
  })

  it('sends the WHOLE template on any edit, both lists', async () => {
    renderWith()
    await userEvent.click(screen.getByLabelText('Enable Impact in the executive summary'))
    const sent = patch.mock.calls[0][0] as { rca: { template: RcaTemplate } }
    expect(sent.rca.template.exec).toHaveLength(5)
    expect(sent.rca.template.tech).toHaveLength(7)
  })

  it('toggles a section off', async () => {
    renderWith()
    await userEvent.click(screen.getByLabelText('Enable Impact in the executive summary'))
    const sent = patch.mock.calls[0][0] as { rca: { template: RcaTemplate } }
    expect(sent.rca.template.exec.find((s) => s.id === 'exec-impact')?.enabled).toBe(false)
  })

  it('moves a section up and reorders the list', async () => {
    renderWith()
    await userEvent.click(screen.getByLabelText('Move Impact up in the executive summary'))
    const sent = patch.mock.calls[0][0] as { rca: { template: RcaTemplate } }
    expect(sent.rca.template.exec.map((s) => s.id)).toEqual([
      'exec-impact',
      'exec-what-happened',
      'exec-root-cause',
      'exec-what-we-did',
      'exec-next-steps'
    ])
  })

  it('disables Move up on the first row', () => {
    renderWith()
    expect(screen.getByLabelText('Move What happened up in the executive summary')).toHaveProperty(
      'disabled',
      true
    )
  })

  it('adds a narrative section to the technical report with a unique id', async () => {
    renderWith()
    await userEvent.click(
      screen.getByRole('button', { name: /add a section to the technical report/i })
    )
    const sent = patch.mock.calls[0][0] as { rca: { template: RcaTemplate } }
    const added = sent.rca.template.tech.at(-1)!
    expect(added.kind).toBe('narrative')
    expect(added.enabled).toBe(true)
    expect(added.id.startsWith('tech-')).toBe(true)
    expect(sent.rca.template.tech.filter((s) => s.id === added.id)).toHaveLength(1)
  })

  it('offers no Remove on a claims row — claims sections are part of the contract', () => {
    renderWith(DEFAULT_RCA_TEMPLATE, 'tech')
    expect(screen.queryByLabelText('Remove Root cause from the technical report')).toBeNull()
    expect(screen.getByLabelText('Enable Root cause in the technical report')).toBeTruthy()
  })

  it('removes a user-added narrative section', async () => {
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    t.tech.push({
      id: 'tech-detection',
      heading: 'Detection',
      kind: 'narrative',
      enabled: true,
      instruction: 'x'
    })
    renderWith(t, 'tech')
    await userEvent.click(screen.getByLabelText('Remove Detection from the technical report'))
    const sent = patch.mock.calls[0][0] as { rca: { template: RcaTemplate } }
    expect(sent.rca.template.tech.some((s) => s.id === 'tech-detection')).toBe(false)
  })

  it('opens one instruction at a time, and offers none for a claims section', () => {
    renderWith()
    // Nothing is open until a pencil is clicked — the old editor rendered all nine at once.
    expect(
      screen.queryByLabelText('Instruction for What happened in the executive summary')
    ).toBeNull()
    openInstruction('What happened in the executive summary')
    expect(
      screen.getByLabelText('Instruction for What happened in the executive summary')
    ).toBeTruthy()
    // Opening another closes the first: one editor, wherever the user last clicked.
    openInstruction('Root cause in the executive summary')
    expect(
      screen.queryByLabelText('Instruction for What happened in the executive summary')
    ).toBeNull()
    expect(
      screen.getByLabelText('Instruction for Root cause in the executive summary')
    ).toBeTruthy()
    // tech "Root cause" is claims-kind: its content comes from the findings, so it has no
    // instruction to open and therefore no pencil at all.
    fireEvent.click(screen.getByLabelText('Toggle the technical report'))
    expect(
      screen.queryByLabelText('Edit the instruction for Root cause in the technical report')
    ).toBeNull()
  })

  it('labels the nameless self-heading section instead of showing an empty field', () => {
    // `tech-narrative` ships with `heading: ''` on purpose — render.ts splices it in raw because
    // it emits its own `## ` headings. As a plain heading input it was a blank line with an
    // editable field that changes nothing, which reads as a bug.
    renderWith(DEFAULT_RCA_TEMPLATE, 'tech')
    expect(screen.getByText(/writes its own headings/i)).toBeTruthy()
    // No heading field at all for this one — and its other controls are addressed by a real
    // name rather than by the empty string.
    expect(
      screen.queryByLabelText('Heading for Analysis narrative in the technical report')
    ).toBeNull()
    expect(screen.getByLabelText('Enable Analysis narrative in the technical report')).toBeTruthy()
    expect(screen.getByLabelText('Move Analysis narrative up in the technical report')).toBeTruthy()
  })

  it('marks exactly the claims rows auto, and names what each is written from', () => {
    renderWith(DEFAULT_RCA_TEMPLATE, 'tech')
    const rows = screen.getAllByRole('listitem')
    const autoRows = rows.filter((li) =>
      [...li.querySelectorAll('span')].some((el) => el.textContent === 'auto')
    )
    // 7 tech sections, 6 of them claims — Impact is narrative and keeps its instruction.
    expect(autoRows).toHaveLength(6)
    const impact = rows.find((li) =>
      li.querySelector('input[aria-label="Heading for Impact in the technical report"]')
    )!
    expect([...impact.querySelectorAll('span')].some((el) => el.textContent === 'auto')).toBe(false)
    expect(
      screen.getByLabelText('Edit the instruction for Impact in the technical report')
    ).toBeTruthy()
    // The chip's tooltip answers the question the chip provokes.
    const rootCause = autoRows[0].querySelector('[title]')!
    expect(rootCause.getAttribute('title')).toMatch(/root cause/i)
  })

  it('names the two same-headed Root cause rows distinctly', () => {
    // Section headings are not unique — the default template ships a "Root cause" in each
    // report — so a control named after the heading alone would address two different fields.
    // getByLabelText throws on multiple matches, which is the assertion.
    renderWith()
    expect(screen.getByLabelText('Heading for Root cause in the executive summary')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Toggle the technical report'))
    expect(screen.getByLabelText('Heading for Root cause in the technical report')).toBeTruthy()
  })

  it('warns when a narrative section has an empty instruction, and does not patch', async () => {
    renderWith()
    openInstruction('What happened in the executive summary')
    const field = screen.getByLabelText('Instruction for What happened in the executive summary')
    await userEvent.clear(field)
    await userEvent.tab()
    expect(screen.getByRole('alert').textContent).toMatch(/instruction/i)
    expect(patch).not.toHaveBeenCalled()
  })

  it('resets to the shipped defaults', async () => {
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    t.exec[0].heading = 'Changed'
    renderWith(t)
    await userEvent.click(screen.getByRole('button', { name: /reset template to defaults/i }))
    // Behind a confirm now: the one irreversible control in the editor.
    expect(confirm).toHaveBeenCalled()
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({ rca: { template: DEFAULT_RCA_TEMPLATE } })
    )
  })

  it('resets nothing when the confirm is declined', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    t.exec[0].heading = 'Changed'
    renderWith(t)
    await userEvent.click(screen.getByRole('button', { name: /reset template to defaults/i }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(patch).not.toHaveBeenCalled()
  })
})

describe('edits compose from the latest local state, not the last round-tripped prop', () => {
  // `settingsStore.patch` is async with no optimistic update: the `template` prop only refreshes
  // after main has round-tripped and written settings.json. Composing every payload from that
  // stale prop means a second edit within the IPC window silently reverts the first, and
  // `deepMerge` replaces arrays wholesale so the later stale write wins on disk.
  it('mints a distinct id when Add is clicked twice before the prop updates', async () => {
    renderWith()
    const add = screen.getByRole('button', { name: /add a section to the technical report/i })
    await userEvent.click(add)
    await userEvent.click(add)
    expect(patch).toHaveBeenCalledTimes(2)
    const second = patch.mock.calls[1][0] as { rca: { template: RcaTemplate } }
    const tech = second.rca.template.tech
    expect(tech).toHaveLength(DEFAULT_RCA_TEMPLATE.tech.length + 2)
    expect(new Set(tech.map((s) => s.id)).size).toBe(tech.length)
  })

  it('keeps a rename when a second control is touched before the prop updates', async () => {
    renderWith()
    const field = screen.getByLabelText('Heading for What happened in the executive summary')
    await userEvent.clear(field)
    await userEvent.type(field, 'Summary')
    await userEvent.tab()
    await userEvent.click(screen.getByLabelText('Enable Impact in the executive summary'))
    const last = patch.mock.calls.at(-1)![0] as { rca: { template: RcaTemplate } }
    const exec = last.rca.template.exec
    expect(exec.find((s) => s.id === 'exec-what-happened')?.heading).toBe('Summary')
    expect(exec.find((s) => s.id === 'exec-impact')?.enabled).toBe(false)
  })
})

describe('Reset to defaults repaints the fields', () => {
  it('shows the default heading after a reset, and blurring does not restore the old value', async () => {
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    t.exec[0].heading = 'Changed heading'
    renderWith(t)
    await userEvent.click(screen.getByRole('button', { name: /reset template to defaults/i }))
    // The row must now READ as the default; an uncontrolled input would still show the old text.
    const field = await screen.findByLabelText('Heading for What happened in the executive summary')
    expect((field as HTMLInputElement).value).toBe('What happened')
    // ...and focusing/blurring it must not patch the discarded value back in.
    patch.mockReset()
    await userEvent.click(field)
    await userEvent.tab()
    for (const call of patch.mock.calls) {
      const sent = call[0] as { rca: { template: RcaTemplate } }
      expect(sent.rca.template.exec[0].heading).not.toBe('Changed heading')
    }
  })
})

describe('two edits inside a single tick', () => {
  // `userEvent` awaits between actions, so React re-renders and every handler sees fresh state —
  // which hides the whole bug class. A real double-click, or a programmatic set-value followed
  // immediately by blur, fires both handlers before any render. Handlers must therefore compute
  // from a synchronously-updated ref, not from the render closure.
  it('mints distinct ids when two Add clicks land before a re-render', () => {
    renderWith()
    const add = screen.getByRole('button', { name: /add a section to the technical report/i })
    act(() => {
      add.click()
      add.click()
    })
    const last = patch.mock.calls.at(-1)![0] as { rca: { template: RcaTemplate } }
    const added = last.rca.template.tech.filter((s) => s.id.startsWith('tech-section-'))
    expect(added).toHaveLength(2)
    expect(new Set(added.map((s) => s.id)).size).toBe(2)
  })

  it('commits a heading typed and blurred before a re-render', () => {
    renderWith()
    const field = screen.getByLabelText(
      'Heading for What happened in the executive summary'
    ) as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(field, 'Summary')
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    const last = patch.mock.calls.at(-1)![0] as { rca: { template: RcaTemplate } }
    expect(last.rca.template.exec.find((s) => s.id === 'exec-what-happened')?.heading).toBe(
      'Summary'
    )
  })
})
