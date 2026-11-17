import {
  DATADOG_SITES,
  DEFAULT_DATADOG_ML_APP,
  PROVIDER_DESCRIPTORS,
  mlAppProblem,
  secretName,
  type DatadogSite
} from '../../../../../shared/observabilityProviders'
import type { ObservabilityProvider } from '../types'
import { DatadogSink, tag } from './sink'
import { createDatadogIntake, intakeBase } from './intake'
import { probeDatadog } from './probe'

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
export const DATADOG_API_KEY_SECRET = secretName('datadog', 'api-key')

/** The settings schema constrains the site; a hand-edited value falls back to the default. */
const siteOf = (v: unknown): DatadogSite =>
  (DATADOG_SITES as readonly string[]).includes(v as string) ? (v as DatadogSite) : DATADOG_SITES[0]
const mlAppOf = (cfg: Record<string, unknown>): string => str(cfg.mlApp) || DEFAULT_DATADOG_ML_APP
/** Only an org policy sets this (the relay of phase 2, or the gate's local receiver). */
const intakeUrlOf = (cfg: Record<string, unknown>): string | null => str(cfg.intakeUrl) || null

export const datadogProvider: ObservabilityProvider = {
  descriptor: PROVIDER_DESCRIPTORS.datadog,
  missing: (_cfg, secret) => (secret(DATADOG_API_KEY_SECRET) ? null : 'api-key'),
  createSink(cfg, secret, ctx) {
    const apiKey = secret(DATADOG_API_KEY_SECRET)
    if (!apiKey) return null
    const mlApp = mlAppOf(cfg)
    // Thrown, not silently fixed: buildExporter turns it into this provider's health row error.
    const problem = mlAppProblem(mlApp)
    if (problem) throw new Error(`invalid ML app "${mlApp}": ${problem}`)
    const site = siteOf(cfg.site)
    const env = str(cfg.env)
    // Set by `applyPolicy` only when the org policy has `identifyUser: true`.
    const user = str(cfg.userLogin)
    const tags = [
      'service:argus',
      tag('version', ctx.appVersion),
      tag('argus.install_id', ctx.installId),
      env ? tag('env', env) : null,
      user ? tag('argus.user', user) : null
    ].filter((t): t is string => t !== null)
    return new DatadogSink(
      createDatadogIntake({ base: intakeBase(site, intakeUrlOf(cfg)), apiKey }),
      { captureContent: ctx.captureContent, mlApp, tags }
    )
  },
  probe: (cfg, secret) => {
    const site = siteOf(cfg.site)
    return probeDatadog({
      base: intakeBase(site, intakeUrlOf(cfg)),
      site,
      apiKey: secret(DATADOG_API_KEY_SECRET) ?? ''
    })
  }
}
