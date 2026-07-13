export const HEALTH_CATEGORIES = ['general', 'tools', 'connectors'] as const
export type HealthCategory = (typeof HEALTH_CATEGORIES)[number]

export const HEALTH_CATEGORY_LABELS: Record<HealthCategory, string> = {
  general: 'General',
  tools: 'Tools',
  connectors: 'Connectors'
}

export interface HealthRow {
  id: string
  label: string
  category: HealthCategory
}

export interface HealthCheckResult {
  id: string
  label: string
  ok: boolean
  detail: string
  fixHint?: string
}
