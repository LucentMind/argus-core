import { z } from 'zod'
import type { FieldAnnotation } from './drivers'

export const RISK_LEVELS = ['low', 'medium', 'high'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

/** The in-process native-tools server; a registry entry may never claim it. */
export const RESERVED_INSTANCE_IDS = ['argus'] as const

const discoveredToolSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  risk: z.enum(RISK_LEVELS)
})
export type DiscoveredTool = z.infer<typeof discoveredToolSchema>

const connectorInstanceSchema = z.looseObject({
  kind: z.string(), // OPEN slug — unknown kinds round-trip and render "unsupported kind"
  displayName: z.string().optional(),
  preset: z.string().optional(), // e.g. 'rovo' — selects form extras, nothing else
  enabled: z.boolean().default(true),
  config: z.unknown().optional(), // opaque; validated lazily per kind via connectorConfig()
  lastDiscovered: z.looseObject({ at: z.string(), tools: z.array(discoveredToolSchema) }).optional()
})
export type ConnectorInstance = z.infer<typeof connectorInstanceSchema>

/** config/mcp-servers.json — one entry per connector instance, key = instanceId. */
export const connectorsSchema = z.record(z.string(), connectorInstanceSchema)
export type ConnectorMap = z.infer<typeof connectorsSchema>

// --- per-kind config (same shape as `claude mcp` config, spec §2.1) --------

export const stdioConfigSchema = z.looseObject({
  command: z.string().default(''),
  args: z.array(z.string()).default(() => []),
  env: z.record(z.string(), z.unknown()).default(() => ({})) // values may be $secret refs
})
export type StdioConnectorConfig = z.infer<typeof stdioConfigSchema>

export const httpConfigSchema = z.looseObject({
  url: z.string().default(''),
  transport: z.enum(['http', 'sse']).default('http'),
  oauth: z.boolean().default(false),
  headers: z.record(z.string(), z.unknown()).default(() => ({})), // values may be $secret refs
  restEmail: z.string().optional(), // Rovo preset: Atlassian REST credentials (consumed in Part 3)
  restApiToken: z.unknown().optional() // $secret ref
})
export type HttpConnectorConfig = z.infer<typeof httpConfigSchema>

const KIND_SCHEMAS: Record<string, z.ZodType> = { stdio: stdioConfigSchema, http: httpConfigSchema }

/** Validate an opaque instance config for its kind; {} on unknown kind, defaults on invalid. */
export function connectorConfig<T>(kind: string, raw: unknown): T {
  const s = KIND_SCHEMAS[kind]
  if (!s) return {} as T
  const r = s.safeParse(raw ?? {})
  return (r.success ? r.data : s.parse({})) as T
}

// --- risk conventions (spec §2.5) -------------------------------------------

const HIGH_RE = /delete|transition|merge|remove/i
const LOW_WORDS = new Set(['get', 'list', 'search', 'read', 'view', 'fetch'])
const MEDIUM_WORDS = new Set(['create', 'update', 'add', 'comment', 'edit'])

/** First word of a camelCase / snake_case / kebab-case tool name, lowercased. */
function firstWord(name: string): string {
  return name.match(/^[a-z]+|^[A-Z][a-z]*/)?.[0]?.toLowerCase() ?? ''
}

/** Name-convention classification. HIGH verbs win anywhere; LOW/MEDIUM by first word; unmatched → MEDIUM. */
export function classifyToolName(name: string): RiskLevel {
  if (HIGH_RE.test(name)) return 'high'
  const head = firstWord(name)
  if (LOW_WORDS.has(head)) return 'low'
  if (MEDIUM_WORDS.has(head)) return 'medium'
  return 'medium'
}

// --- $secret references ------------------------------------------------------

export interface SecretRef {
  $secret: string
}

export function isSecretRef(v: unknown): v is SecretRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).$secret === 'string'
  )
}

export function collectSecretRefs(v: unknown): string[] {
  if (isSecretRef(v)) return [v.$secret]
  if (Array.isArray(v)) return v.flatMap(collectSecretRefs)
  if (typeof v === 'object' && v !== null) return Object.values(v).flatMap(collectSecretRefs)
  return []
}

/** Deep-copy `v` with every $secret ref replaced by its plaintext; unresolvable refs become '' and are reported. */
export function resolveSecretRefs(
  v: unknown,
  lookup: (name: string) => string | null
): { value: unknown; missing: string[] } {
  const missing: string[] = []
  const walk = (x: unknown): unknown => {
    if (isSecretRef(x)) {
      const s = lookup(x.$secret)
      if (s == null) {
        missing.push(x.$secret)
        return ''
      }
      return s
    }
    if (Array.isArray(x)) return x.map(walk)
    if (typeof x === 'object' && x !== null)
      return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]))
    return x
  }
  return { value: walk(v), missing }
}

// --- forms + preset (rendered by AnnotatedForm, settings-spec mechanism) -----

export const CONNECTOR_FORMS: Record<string, Record<string, FieldAnnotation>> = {
  stdio: {
    command: { control: 'text', label: 'Command', placeholder: 'npx', order: 1 },
    args: {
      control: 'text',
      label: 'Arguments (space-separated)',
      placeholder: '-y my-mcp-server',
      order: 2
    },
    env: {
      control: 'textarea',
      label: 'Environment (JSON object; values may be {"$secret":"name"})',
      placeholder: '{}',
      order: 3
    }
  },
  http: {
    url: { control: 'text', label: 'URL', placeholder: 'https://…', order: 1 },
    transport: {
      control: 'select',
      label: 'Transport',
      options: ['http', 'sse'],
      order: 2,
      defaultValue: 'http'
    },
    headers: {
      control: 'textarea',
      label: 'Headers (JSON object; values may be {"$secret":"name"})',
      placeholder: '{}',
      order: 3
    }
  }
}

/** Extra fields shown only on the Rovo preset card (REST credentials for Part 3). */
export const ROVO_FORM_EXTRAS: Record<string, FieldAnnotation> = {
  restEmail: {
    control: 'text',
    label: 'Atlassian email (REST)',
    placeholder: 'you@example.com',
    order: 10
  },
  restApiToken: {
    control: 'password',
    label: 'Atlassian API token (REST)',
    order: 11,
    sensitive: true
  }
}

export const ROVO_PRESET = {
  instanceId: 'rovo',
  instance: {
    kind: 'http',
    displayName: 'Atlassian Rovo',
    preset: 'rovo',
    enabled: true,
    config: { url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse', oauth: true }
  }
} as const

// --- runtime + IPC payload shapes --------------------------------------------

export type ConnectorRuntimeState =
  | { state: 'never-connected' }
  | { state: 'connected'; at: string; toolCount: number }
  | { state: 'needs-auth' }
  | { state: 'error'; reason: string }

export type OAuthStatus = 'authorized' | 'not-authorized' | 'error'

export interface ConnectorsPayload {
  connectors: ConnectorMap
  runtime: Record<string, ConnectorRuntimeState>
  oauth: Record<string, OAuthStatus>
  loadError: string | null
  secretsAvailable: boolean
  secretsLoadError: string | null
}

/** Result of composing enabled connectors for a new session (Agent SDK mcpServers map + logged skips). */
export interface ComposedMcp {
  servers: Record<string, unknown>
  skipped: Array<{ instanceId: string; reason: string }>
}
