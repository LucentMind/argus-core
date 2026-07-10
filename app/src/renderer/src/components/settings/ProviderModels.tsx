import { useState } from 'react'
import { settingsStore } from '../../lib/settingsStore'
import { IconBtn, Chip, Btn } from '../ui'
import { FIELD } from './settingsLayout'
import { instanceModels, orderedModels } from '../../../../shared/drivers'
import type { AppSettings, ModelPreferences } from '../../../../shared/settings'

const MAX_CUSTOM_MODEL_LENGTH = 100

const EMPTY_PREFS: ModelPreferences = { hiddenModels: [], favoriteModels: [], modelOrder: [] }

/* Small inline SVGs, matching TopBar's icon idiom (stroke=currentColor, 14px). */
const ICON = {
  size: 14,
  common: {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  }
} as const

function StarIcon({ filled }: { filled: boolean }): React.JSX.Element {
  return (
    <svg
      width={ICON.size}
      height={ICON.size}
      viewBox="0 0 24 24"
      {...ICON.common}
      fill={filled ? 'currentColor' : 'none'}
    >
      <path d="M12 2.5 15.1 8.8 22 9.8l-5 4.9 1.2 6.9L12 18.3l-6.2 3.3L7 14.7l-5-4.9 6.9-1z" />
    </svg>
  )
}

function ArrowUpIcon(): React.JSX.Element {
  return (
    <svg width={ICON.size} height={ICON.size} viewBox="0 0 24 24" {...ICON.common}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  )
}

function ArrowDownIcon(): React.JSX.Element {
  return (
    <svg width={ICON.size} height={ICON.size} viewBox="0 0 24 24" {...ICON.common}>
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  )
}

function EyeIcon(): React.JSX.Element {
  return (
    <svg width={ICON.size} height={ICON.size} viewBox="0 0 24 24" {...ICON.common}>
      <path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon(): React.JSX.Element {
  return (
    <svg width={ICON.size} height={ICON.size} viewBox="0 0 24 24" {...ICON.common}>
      <path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z" />
      <circle cx="12" cy="12" r="3" />
      <path d="M2 2l20 20" />
    </svg>
  )
}

function XIcon(): React.JSX.Element {
  return (
    <svg width={ICON.size} height={ICON.size} viewBox="0 0 24 24" {...ICON.common}>
      <path d="M5 5l14 14M19 5 5 19" />
    </svg>
  )
}

/**
 * Model list for a provider instance (t3code `ProviderModelsSection`, OEH-styled):
 * favorite/hide/reorder built-ins, add/remove custom slugs. Arrow buttons instead
 * of drag — move up/down only swaps within the same favorite/non-favorite group,
 * mirroring t3code's `canMoveUp`/`canMoveDown`.
 */
export function ProviderModels({
  settings,
  instanceId
}: {
  settings: AppSettings
  instanceId: string
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  const prefs = settings.agent.modelPreferences[instanceId] ?? EMPTY_PREFS
  const models = orderedModels(settings, instanceId)
  const builtinSlugs = new Set(
    instanceModels(settings, instanceId)
      .filter((m) => !m.isCustom)
      .map((m) => m.slug)
  )
  const customSlugs = models.filter((m) => m.isCustom).map((m) => m.slug)
  const favSet = new Set(prefs.favoriteModels)
  const hiddenSet = new Set(prefs.hiddenModels)

  function patchPrefs(next: ModelPreferences): void {
    const allEmpty =
      next.hiddenModels.length === 0 &&
      next.favoriteModels.length === 0 &&
      next.modelOrder.length === 0
    void settingsStore.patch({
      agent: { modelPreferences: { [instanceId]: allEmpty ? null : next } }
    })
  }

  function patchCustomModels(next: string[]): void {
    void settingsStore.patch({
      agent: { providerInstances: { [instanceId]: { config: { customModels: next } } } }
    })
  }

  function handleToggleFavorite(slug: string): void {
    const favoriteModels = favSet.has(slug)
      ? prefs.favoriteModels.filter((s) => s !== slug)
      : [...prefs.favoriteModels, slug]
    patchPrefs({ ...prefs, favoriteModels })
  }

  function handleToggleHidden(slug: string): void {
    const hiddenModels = hiddenSet.has(slug)
      ? prefs.hiddenModels.filter((s) => s !== slug)
      : [...prefs.hiddenModels, slug]
    patchPrefs({ ...prefs, hiddenModels })
  }

  function handleMove(slug: string, direction: -1 | 1): void {
    const slugs = models.map((m) => m.slug)
    const index = slugs.indexOf(slug)
    const nextIndex = index + direction
    if (index < 0 || nextIndex < 0 || nextIndex >= slugs.length) return
    const next = [...slugs]
    ;[next[index], next[nextIndex]] = [next[nextIndex], next[index]]
    patchPrefs({ ...prefs, modelOrder: next })
  }

  function handleRemove(slug: string): void {
    patchCustomModels(customSlugs.filter((s) => s !== slug))
    patchPrefs({
      ...prefs,
      favoriteModels: prefs.favoriteModels.filter((s) => s !== slug),
      modelOrder: prefs.modelOrder.filter((s) => s !== slug)
    })
  }

  function handleAdd(): void {
    const slug = input.trim()
    if (!slug) {
      setError('Enter a model slug.')
      return
    }
    if (builtinSlugs.has(slug)) {
      setError('That model is already built in.')
      return
    }
    if (slug.length > MAX_CUSTOM_MODEL_LENGTH) {
      setError(`Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`)
      return
    }
    if (customSlugs.includes(slug)) {
      setError('That custom model is already saved.')
      return
    }
    patchCustomModels([...customSlugs, slug])
    setInput('')
    setError(null)
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="text-xs text-ink">Models · {models.length} available</div>
      <div className="flex max-h-64 flex-col overflow-y-auto">
        {models.map((m, i) => {
          const isFavorite = favSet.has(m.slug)
          const isHidden = !m.isCustom && hiddenSet.has(m.slug)
          const prevModel = models[i - 1]
          const nextModel = models[i + 1]
          const canMoveUp = prevModel !== undefined && favSet.has(prevModel.slug) === isFavorite
          const canMoveDown = nextModel !== undefined && favSet.has(nextModel.slug) === isFavorite
          return (
            <div key={m.slug} className="flex min-h-7 items-center gap-2 py-1">
              <span
                className={`min-w-0 flex-1 truncate text-xs ${
                  isHidden ? 'text-mute line-through' : 'text-ink'
                }`}
              >
                {m.name}
              </span>
              {m.isCustom && <Chip>custom</Chip>}
              {isHidden && <Chip>hidden</Chip>}
              <div className="flex shrink-0 items-center gap-0.5">
                <IconBtn
                  aria-label={`${isFavorite ? 'Remove' : 'Add'} ${m.name} ${isFavorite ? 'from' : 'to'} favorites`}
                  title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                  className={isFavorite ? 'text-review' : ''}
                  onClick={() => handleToggleFavorite(m.slug)}
                >
                  <StarIcon filled={isFavorite} />
                </IconBtn>
                <IconBtn
                  aria-label={`Move ${m.name} up`}
                  title="Move up"
                  disabled={!canMoveUp}
                  onClick={() => handleMove(m.slug, -1)}
                >
                  <ArrowUpIcon />
                </IconBtn>
                <IconBtn
                  aria-label={`Move ${m.name} down`}
                  title="Move down"
                  disabled={!canMoveDown}
                  onClick={() => handleMove(m.slug, 1)}
                >
                  <ArrowDownIcon />
                </IconBtn>
                {!m.isCustom && (
                  <IconBtn
                    aria-label={`${isHidden ? 'Show' : 'Hide'} ${m.name}`}
                    title={isHidden ? 'Show in picker' : 'Hide from picker'}
                    onClick={() => handleToggleHidden(m.slug)}
                  >
                    {isHidden ? <EyeIcon /> : <EyeOffIcon />}
                  </IconBtn>
                )}
                {m.isCustom && (
                  <IconBtn
                    aria-label={`Remove ${m.name}`}
                    title="Remove custom model"
                    onClick={() => handleRemove(m.slug)}
                  >
                    <XIcon />
                  </IconBtn>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-2">
        <input
          aria-label="Add custom model slug"
          className={`${FIELD} w-56 font-mono`}
          placeholder="model-slug"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
        />
        <Btn onClick={handleAdd}>Add</Btn>
      </div>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  )
}
