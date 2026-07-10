import { JsonFileStore } from './fileStore'
import { toolRiskPath } from './paths'
import { z } from 'zod'
import { RISK_LEVELS, type RiskLevel } from '../../shared/connectors'

const toolRiskSchema = z.record(z.string(), z.enum(RISK_LEVELS))

/**
 * Hand-editable config/tool-risk.json, keys '<instanceId>/<toolName>'.
 * Watched — overrides apply live, even to running sessions (spec §2.5).
 * No UI this wave; invalid content degrades to {}.
 */
export class ToolRiskStore {
  private store: JsonFileStore
  private overrides: Record<string, RiskLevel> = {}
  private unwatch: () => void

  constructor(argusHome: string) {
    this.store = new JsonFileStore(toolRiskPath(argusHome))
    this.overrides = this.loadNow()
    this.unwatch = this.store.watch(() => {
      this.overrides = this.loadNow()
    })
  }

  private loadNow(): Record<string, RiskLevel> {
    const { data } = this.store.load()
    const r = toolRiskSchema.safeParse(data)
    return r.success ? r.data : {}
  }

  get(): Record<string, RiskLevel> {
    return this.overrides
  }

  close(): void {
    this.unwatch()
    this.store.close()
  }
}
