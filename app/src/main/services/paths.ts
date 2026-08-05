import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ARTIFACTS_DIR, EVIDENCE_DIR, dirForMode } from '../../shared/evidenceScope'
import type { ModeId } from '../../shared/modes'

/** User-chosen data-root override, persisted outside argusHome (chicken/egg: it names argusHome). */
export function rootOverridePath(userDataDir: string): string {
  return path.join(userDataDir, 'data-root-override.json')
}

/** ARGUS_HOME env wins (explicit ops override); else a user-chosen override; else ~/Argus. */
export function resolveArgusHome(userDataDir?: string): string {
  if (process.env.ARGUS_HOME) return process.env.ARGUS_HOME
  if (userDataDir) {
    try {
      const raw = JSON.parse(fs.readFileSync(rootOverridePath(userDataDir), 'utf8')) as {
        path?: string
      }
      if (raw.path?.trim()) return raw.path
    } catch {
      /* no override on disk — fall through to the default */
    }
  }
  return path.join(os.homedir(), 'Argus')
}

export function writeRootOverride(userDataDir: string, dataRoot: string): void {
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(rootOverridePath(userDataDir), JSON.stringify({ path: dataRoot }))
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

export function memoryArchiveDir(argusHome: string): string {
  return path.join(memoryDir(argusHome), 'archive')
}

/** Single-level backup of a replaced topic body. Dot-prefixed so listTopics (memory/*.md) and
 *  listArchivedTopics (memory/archive) never walk it. */
export function memoryBackupDir(argusHome: string): string {
  return path.join(memoryDir(argusHome), '.bak')
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

export function packsStatePath(argusHome: string): string {
  return path.join(configDir(argusHome), 'packs-state.json')
}

export function proposalsDir(argusHome: string): string {
  return path.join(argusHome, 'proposals')
}

export function proposalsArchiveDir(argusHome: string): string {
  return path.join(proposalsDir(argusHome), 'archive')
}

export function draftsDir(argusHome: string): string {
  return path.join(argusHome, 'drafts')
}

export function refSyncPath(argusHome: string): string {
  return path.join(configDir(argusHome), 'reference-sync.json')
}

export function refSyncStatePath(argusHome: string): string {
  return path.join(configDir(argusHome), 'reference-sync.state.json')
}

export function deletionAuditPath(argusHome: string): string {
  return path.join(argusHome, '.audit', 'deletions.jsonl')
}

export function evidenceDir(argusHome: string, slug: string): string {
  return path.join(caseDir(argusHome, slug), EVIDENCE_DIR)
}

export function artifactsDir(argusHome: string, slug: string): string {
  return path.join(caseDir(argusHome, slug), ARTIFACTS_DIR)
}

/** Where material ingested in `mode` is stored. */
export function modeDir(argusHome: string, slug: string, mode: ModeId): string {
  return path.join(caseDir(argusHome, slug), dirForMode(mode))
}
