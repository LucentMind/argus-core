import { JsonFileStore } from './fileStore'
import { secretsPath } from './paths'

/**
 * Injected subset of Electron's safeStorage — kept as an interface so this
 * module never imports 'electron' and stays unit-testable in plain node.
 */
export interface SecretCrypto {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * Each secret encrypted individually; ciphertexts persisted as
 * config/secrets.json ({ name: base64 }). Plaintext never touches JSON, logs,
 * renderer state, or IPC replies — resolve() is main-process-only.
 */
export class SecretStore {
  private store: JsonFileStore
  private names = new Map<string, string>() // name → base64 ciphertext
  private error: string | null = null

  constructor(
    argusHome: string,
    private crypto: SecretCrypto
  ) {
    this.store = new JsonFileStore(secretsPath(argusHome))
    const { data, error } = this.store.load()
    this.error = error
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data)) if (typeof v === 'string') this.names.set(k, v)
    }
  }

  available(): boolean {
    return this.crypto.isEncryptionAvailable()
  }

  loadError(): string | null {
    return this.error
  }

  set(name: string, value: string): void {
    if (!this.available())
      throw new Error('secret store unavailable: OS encryption is not available on this machine')
    this.names.set(name, this.crypto.encryptString(value).toString('base64'))
    this.persist()
  }

  has(name: string): boolean {
    return this.names.has(name)
  }

  delete(name: string): void {
    if (this.names.delete(name)) this.persist()
  }

  /** Delete every name starting with `prefix` (e.g. `connector/<id>/`); persists once if any matched. */
  deletePrefix(prefix: string): void {
    let changed = false
    for (const name of [...this.names.keys()]) {
      if (name.startsWith(prefix)) {
        this.names.delete(name)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  /** MAIN-PROCESS ONLY. null when absent or undecryptable (key changed / corrupt). */
  resolve(name: string): string | null {
    const b64 = this.names.get(name)
    if (b64 == null) return null
    try {
      return this.crypto.decryptString(Buffer.from(b64, 'base64'))
    } catch {
      return null
    }
  }

  private persist(): void {
    this.store.write(Object.fromEntries(this.names))
    this.error = null // an explicit save replaces a previously broken file
  }

  close(): void {
    this.store.close()
  }
}
