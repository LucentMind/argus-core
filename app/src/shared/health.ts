export interface HealthRow {
  id: string
  label: string
}

export interface HealthCheckResult {
  id: string
  label: string
  ok: boolean
  detail: string
  fixHint?: string
}
