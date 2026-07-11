// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InstalledSkills } from '../settings/InstalledSkills'
import { SkillsSettings } from '../settings/SkillsSettings'
import { accessStore } from '../../lib/accessStore'

const skills = {
  skills: [
    { name: 'rca', tier: 'user', description: 'override rca', enabled: true, shadows: ['bundled'] },
    {
      name: 'analyze-applog',
      tier: 'bundled',
      description: 'applog triage',
      enabled: false,
      shadows: []
    }
  ]
}

beforeEach(() => {
  accessStore.reset()
  window.argus = {
    access: {
      get: vi.fn(async () => ({ access: { skills: {}, memory: {} }, loadError: null })),
      patch: vi.fn(async () => ({ access: { skills: {}, memory: {} }, loadError: null })),
      onChanged: vi.fn(() => () => {})
    },
    skills: { list: vi.fn(async () => skills) },
    proposals: { list: vi.fn(async () => ({ proposals: [] })) }
  } as never
})

describe('InstalledSkills', () => {
  it('groups by tier and badges shadowing', async () => {
    render(<InstalledSkills />)
    expect(await screen.findByText('User skills')).toBeTruthy()
    expect(screen.getByText('Bundled skills')).toBeTruthy()
    expect(screen.getByText(/overrides bundled/i)).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'enabled · bundled/analyze-applog' })).toHaveProperty(
      'ariaChecked',
      'false'
    )
  })

  it('toggle patches tier-qualified access key and refetches with the flipped state', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(skills)
      .mockResolvedValueOnce({
        skills: [{ ...skills.skills[0], enabled: false }, skills.skills[1]]
      })
    window.argus.skills.list = list

    render(<InstalledSkills />)
    const toggle = await screen.findByRole('switch', { name: 'enabled · user/rca' })
    expect(toggle).toHaveProperty('ariaChecked', 'true')

    fireEvent.click(toggle)
    await waitFor(() =>
      expect(window.argus.access.patch).toHaveBeenCalledWith({ skills: { 'user/rca': false } })
    )
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'enabled · user/rca' })).toHaveProperty(
        'ariaChecked',
        'false'
      )
    )
  })
})

describe('SkillsSettings tabs', () => {
  it('offers only Installed and Proposals — HiveMind moved to its own settings page', async () => {
    render(<SkillsSettings />)
    await screen.findByRole('tab', { name: 'Installed' })
    expect(screen.getByRole('tab', { name: 'Proposals' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /HiveMind/ })).toBeNull()
  })
})
