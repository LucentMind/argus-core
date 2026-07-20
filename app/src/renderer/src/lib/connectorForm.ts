import { connectorsStore } from './connectorsStore'
import { alert } from './confirmStore'

/** Adapt raw connector config to AnnotatedForm scalars (args ↔ space-joined, env/headers ↔ JSON text). */
export function formValue(kind: string, cfg: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'stdio')
    return {
      ...cfg,
      args: Array.isArray(cfg.args) ? (cfg.args as string[]).join(' ') : '',
      env: cfg.env && Object.keys(cfg.env).length ? JSON.stringify(cfg.env) : ''
    }
  if (kind === 'http')
    return {
      ...cfg,
      headers:
        cfg.headers && Object.keys(cfg.headers as object).length ? JSON.stringify(cfg.headers) : ''
    }
  return cfg
}

/** Persist a non-secret connector config field (AnnotatedForm onChange). */
export function commitField(id: string, kind: string, key: string, v: unknown | null): void {
  let out: unknown = v
  if (kind === 'stdio' && key === 'args')
    out = v == null ? null : String(v).split(/\s+/).filter(Boolean)
  if ((kind === 'stdio' && key === 'env') || (kind === 'http' && key === 'headers')) {
    if (v == null) out = null
    else {
      try {
        out = JSON.parse(String(v))
      } catch {
        return // invalid JSON: keep the draft, commit nothing
      }
    }
  }
  void connectorsStore.patch({ [id]: { config: { [key]: out } } })
}

/** Persist a sensitive connector config field: store the plaintext in the secret store, keep a `$secret` ref in config. */
export function commitSecret(id: string, key: string, plaintext: string | null): void {
  const name = `connector/${id}/${key}`
  if (plaintext == null) {
    void window.argus.secrets.delete(name)
    void connectorsStore.patch({ [id]: { config: { [key]: null } } })
    return
  }
  void window.argus.secrets
    .set(name, plaintext)
    .then(() => connectorsStore.patch({ [id]: { config: { [key]: { $secret: name } } } }))
    .catch((err: Error) => void alert(`secret not saved: ${err.message}`))
}
