import os from 'node:os'
import path from 'node:path'

export function resolveArgusHome(): string {
  return process.env.ARGUS_HOME ?? path.join(os.homedir(), 'Argus')
}

export function dbPath(argusHome: string): string {
  return path.join(argusHome, 'argus.db')
}

export function caseDir(argusHome: string, slug: string): string {
  return path.join(argusHome, 'cases', slug)
}

export function configDir(argusHome: string): string {
  return path.join(argusHome, 'config')
}

export function settingsPath(argusHome: string): string {
  return path.join(configDir(argusHome), 'settings.json')
}

export function mcpServersPath(argusHome: string): string {
  return path.join(configDir(argusHome), 'mcp-servers.json')
}

export function secretsPath(argusHome: string): string {
  return path.join(configDir(argusHome), 'secrets.json')
}

export function toolRiskPath(argusHome: string): string {
  return path.join(configDir(argusHome), 'tool-risk.json')
}

export function presetsPath(argusHome: string): string {
  return path.join(configDir(argusHome), 'connector-presets.json')
}

export function agentAccessPath(argusHome: string): string {
  return path.join(configDir(argusHome), 'agent-access.json')
}

export function memoryDir(argusHome: string): string {
  return path.join(argusHome, 'memory')
}

export function memoryIndexPath(argusHome: string): string {
  return path.join(memoryDir(argusHome), '_index.md')
}

export function memoryAuditPath(argusHome: string): string {
  return path.join(memoryDir(argusHome), '.audit.jsonl')
}

export function userSkillsDir(argusHome: string): string {
  return path.join(argusHome, 'skills-user')
}

export function hivemindSkillsDir(argusHome: string): string {
  return path.join(argusHome, 'skills-hivemind')
}

export function hivemindCloneDir(argusHome: string): string {
  return path.join(argusHome, 'hivemind')
}

export function hivemindStatePath(argusHome: string): string {
  return path.join(configDir(argusHome), 'hivemind-state.json')
}

export function proposalsDir(argusHome: string): string {
  return path.join(argusHome, 'proposals')
}

export function proposalsArchiveDir(argusHome: string): string {
  return path.join(proposalsDir(argusHome), 'archive')
}
