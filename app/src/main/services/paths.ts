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
