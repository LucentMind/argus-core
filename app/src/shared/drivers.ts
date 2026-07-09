import { z } from 'zod'
import type { AppSettings } from './settings'

export interface FieldAnnotation {
  control: 'text' | 'password' | 'textarea' | 'select' | 'switch' | 'number'
  label: string
  placeholder?: string
  options?: readonly string[]
  order: number
  /** RESERVED — no driver field may set this until the keychain secret store lands (Wave 2 Part 2). */
  sensitive?: boolean
}

export interface DriverDefinition {
  kind: string
  label: string
  configSchema: z.ZodType
  formAnnotations: Record<string, FieldAnnotation>
}

const claudeConfigSchema = z.looseObject({
  model: z.string().optional(),
  cliPath: z.string().optional()
})
export type ClaudeDriverConfig = z.infer<typeof claudeConfigSchema>

export const DRIVERS: Record<string, DriverDefinition> = {
  'claude-agent-sdk': {
    kind: 'claude-agent-sdk',
    label: 'Claude Agent SDK',
    configSchema: claudeConfigSchema,
    formAnnotations: {
      model: { control: 'text', label: 'Model', placeholder: 'CLI default', order: 1 },
      cliPath: { control: 'text', label: 'Claude CLI path', placeholder: 'auto-detect', order: 2 }
    }
  }
}

export function getDriver(slug: string): DriverDefinition | null {
  return DRIVERS[slug] ?? null
}

/** Validate an opaque instance config against its driver's schema; {} on unknown driver or invalid config. */
export function driverConfig<T>(slug: string, raw: unknown): T {
  const d = getDriver(slug)
  if (!d) return {} as T
  const r = d.configSchema.safeParse(raw ?? {})
  return (r.success ? r.data : {}) as T
}

/** Config of the active, enabled provider instance ({} if missing/disabled/unknown driver). */
export function activeInstanceConfig(s: AppSettings): ClaudeDriverConfig {
  const a = s.agent
  const inst = a.providerInstances[a.activeInstanceId]
  if (!inst || !inst.enabled) return {}
  return driverConfig<ClaudeDriverConfig>(inst.driver, inst.config)
}
