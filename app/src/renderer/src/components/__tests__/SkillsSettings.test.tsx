// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
    skills: { list: vi.fn(async () => skills) }
  } as never
})

describe('SkillsSettings', () => {
  it('groups by tier and badges shadowing', async () => {
    render(<SkillsSettings />)
    expect(await screen.findByText('User skills')).toBeTruthy()
    expect(screen.getByText('Bundled skills')).toBeTruthy()
    expect(screen.getByText(/overrides bundled/i)).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'enabled · bundled/analyze-applog' })).toHaveProperty(
      'ariaChecked',
      'false'
    )
  })

  it('toggle patches tier-qualified access key and refetches', async () => {
    render(<SkillsSettings />)
    fireEvent.click(await screen.findByRole('switch', { name: 'enabled · user/rca' }))
    await waitFor(() =>
      expect(window.argus.access.patch).toHaveBeenCalledWith({ skills: { 'user/rca': false } })
    )
    await waitFor(() => expect(window.argus.skills.list).toHaveBeenCalledTimes(2))
  })
})
