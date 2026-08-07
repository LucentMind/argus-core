import type { DiagnosticsObjectKind, ProcessSample } from '../../../shared/diagnostics'
import { identityKey } from './identity'

/**
 * Tier-A labels: recorded by Argus at the spawn sites where a child's pid is
 * reachable, and therefore authoritative rather than inferred.
 *
 * The hard part is identity. Argus knows the pid at `spawn()` but NOT the
 * OS-reported start time, so a registration cannot be keyed on `pid:startTimeMs`
 * at creation. Entries are therefore recorded UNPINNED and pinned on the first
 * sample that reports the pid, if the observed start time is close enough to when
 * we registered. Anything else is a pid we did not spawn.
 */

/** How far the observed start time may sit from registration and still be ours. */
export const PIN_TOLERANCE_MS = 5_000

export type RegisteredLabel = {
  kind: DiagnosticsObjectKind
  label: string
  /** kind 'driver' — the provider id, e.g. 'cursor'. */
  provider?: string
  /** kind 'mcp' — the connector instance id. */
  instanceId?: string
  /**
   * Opaque key of the Argus object that owns this process, e.g. `${caseSlug}:${sessionId}`.
   * Compared against a live-owner set to detect orphans; never parsed.
   */
  owner?: string
}

type Entry = {
  pid: number
  registeredAtMs: number
  label: RegisteredLabel
  /** Set once pinned; undefined while the entry is still unconfirmed. */
  startTimeMs?: number
}

export class ProcessLabels {
  private entries = new Map<number, Entry>()

  /** Record a label for a pid we just spawned. Overwrites any stale entry for that pid. */
  register(pid: number, label: RegisteredLabel, nowMs: number): void {
    this.entries.set(pid, { pid, registeredAtMs: nowMs, label })
  }

  /** Forget a pid — call on process exit. Safe to call for a pid never registered. */
  unregister(pid: number): void {
    this.entries.delete(pid)
  }

  /** Pinned entries currently held. Test and diagnostics aid; not on the wire. */
  pinnedCount(): number {
    let n = 0
    for (const e of this.entries.values()) if (e.startTimeMs !== undefined) n += 1
    return n
  }

  /**
   * Fold one sidecar sample set into the registry and return the labels the pure
   * model should apply, keyed `${pid}:${startTimeMs}`.
   *
   * This is the ONLY mutating entry point on the sampling path, and it lives here
   * rather than in the resolver so `labels.ts` stays pure — the resolver receives
   * an already-settled readonly map.
   *
   * Three things happen, in order: unpinned entries too old to still be waiting on
   * their process are dropped; unpinned entries whose pid now appears are pinned or
   * discarded; and pinned entries whose exact process is gone are swept, so a missed
   * `unregister` cannot leak.
   */
  reconcile(
    samples: readonly ProcessSample[],
    nowMs: number
  ): ReadonlyMap<string, RegisteredLabel> {
    const byPid = new Map<number, ProcessSample>()
    for (const s of samples) if (!byPid.has(s.pid)) byPid.set(s.pid, s)

    const out = new Map<string, RegisteredLabel>()

    for (const [pid, entry] of [...this.entries]) {
      const sample = byPid.get(pid)

      if (entry.startTimeMs === undefined) {
        if (!sample) {
          // Never observed. Past the tolerance the spawn either failed or the process
          // already exited, so stop holding the slot.
          if (nowMs - entry.registeredAtMs > PIN_TOLERANCE_MS) this.entries.delete(pid)
          continue
        }
        if (Math.abs(sample.startTimeMs - entry.registeredAtMs) > PIN_TOLERANCE_MS) {
          // Right pid, wrong process — the pid was reused. Discard rather than
          // mislabel, and do not retry: a later sample cannot make this one ours.
          this.entries.delete(pid)
          continue
        }
        entry.startTimeMs = sample.startTimeMs
      } else if (!sample || sample.startTimeMs !== entry.startTimeMs) {
        // Exited, or the pid now belongs to a different process.
        this.entries.delete(pid)
        continue
      }

      out.set(identityKey(pid, entry.startTimeMs), entry.label)
    }

    return out
  }
}

/**
 * The single instance the spawn sites write to and `index.ts` injects into
 * DiagnosticsService.
 *
 * A module-level default beside an injectable class is the same shape
 * `defaultAcpClientFactory` and `defaultCodexClientFactory` already use in this
 * codebase. It exists because the drivers are constructed at import time by the
 * `DRIVERS` const in `agent/driverRegistry.ts`, which has no dependency channel —
 * threading a registry to them would mean rewriting shipped driver registration.
 * Tests construct `new ProcessLabels()` directly and never touch this.
 */
export const defaultProcessLabels = new ProcessLabels()
