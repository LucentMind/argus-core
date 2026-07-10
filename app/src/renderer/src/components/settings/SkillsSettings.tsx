import { useCallback, useEffect, useState } from 'react'
import { SettingsSection, SettingRow, Switch } from './settingsLayout'
import { Chip } from '../ui'
import { accessStore } from '../../lib/accessStore'
import type { SkillsPayload, SkillListItem } from '../../../../shared/memoryIpc'

const TIER_ORDER = ['user', 'hivemind', 'bundled'] as const
const TIER_TITLE: Record<(typeof TIER_ORDER)[number], string> = {
  user: 'User skills',
  hivemind: 'HiveMind skills',
  bundled: 'Bundled skills'
}
const TIER_EMPTY: Partial<Record<(typeof TIER_ORDER)[number], string>> = {
  user: 'No user skills yet — accepted contribute-back proposals land here (Wave 3 Part 2).',
  hivemind: 'No HiveMind skills installed — configure hivemind.repo in Wave 3 Part 2.'
}

export function SkillsSettings(): React.JSX.Element {
  const [payload, setPayload] = useState<SkillsPayload | null>(null)

  const refresh = useCallback(async () => {
    setPayload(await window.argus.skills.list())
  }, [])

  useEffect(() => {
    let mounted = true
    void (async () => {
      const data = await window.argus.skills.list()
      if (!mounted) return
      setPayload(data)
    })()
    return () => {
      mounted = false
    }
  }, [])

  async function toggle(s: SkillListItem, v: boolean): Promise<void> {
    await accessStore.patch({ skills: { [`${s.tier}/${s.name}`]: v } })
    void refresh() // enablement is computed main-side
  }

  if (!payload) return <div className="text-dim">loading…</div>

  return (
    <div className="flex flex-col gap-6">
      {TIER_ORDER.map((tier) => {
        const items = payload.skills.filter((s) => s.tier === tier)
        if (items.length === 0 && !TIER_EMPTY[tier]) return null
        return (
          <SettingsSection key={tier} title={TIER_TITLE[tier]}>
            {items.length === 0 && (
              <div className="px-3 py-2 text-xs text-dim">{TIER_EMPTY[tier]}</div>
            )}
            {items.map((s) => (
              <SettingRow
                key={s.name}
                label={s.name}
                description={s.description}
                badge={
                  s.shadows.length > 0 ? (
                    <Chip tone="review">overrides {s.shadows.join(', ')}</Chip>
                  ) : undefined
                }
              >
                <Switch
                  checked={s.enabled}
                  onChange={(v) => void toggle(s, v)}
                  aria-label={`enabled · ${s.tier}/${s.name}`}
                />
              </SettingRow>
            ))}
          </SettingsSection>
        )
      })}
    </div>
  )
}
