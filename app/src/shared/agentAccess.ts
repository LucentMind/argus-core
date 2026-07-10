import { z } from 'zod'

/**
 * Sparse access map (spec §1.1): a key is present only as an override.
 * Absent = enabled. Skill keys are tier-qualified: 'bundled/<name>',
 * 'user/<name>', 'hivemind/<name>'. Memory keys are bare topic names.
 */
export const agentAccessSchema = z.looseObject({
  skills: z.record(z.string(), z.boolean()).default(() => ({})),
  memory: z.record(z.string(), z.boolean()).default(() => ({}))
})

export type AgentAccess = z.infer<typeof agentAccessSchema>

export function defaultAgentAccess(): AgentAccess {
  return agentAccessSchema.parse({})
}

export function skillEnabled(access: AgentAccess, key: string): boolean {
  return access.skills[key] !== false
}

export function topicEnabled(access: AgentAccess, topic: string): boolean {
  return access.memory[topic] !== false
}

export interface AgentAccessPayload {
  access: AgentAccess
  loadError: string | null
}
