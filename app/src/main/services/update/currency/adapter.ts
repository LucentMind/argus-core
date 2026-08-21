import type { AdapterId, ApplyOutcome, Candidate } from '../../../../shared/currency'

/**
 * One updatable domain, reduced to two questions.
 *
 * ADAPTERS CLASSIFY; THE SERVICE SCHEDULES. An adapter is the only thing that knows what a
 * trust-tier restamp is; the service is the only thing that knows when a write is safe, how long
 * to back off, and what the user has tombstoned. Neither reaches into the other's job.
 */
export interface CurrencyAdapter {
  id: AdapterId
  /**
   * Reads network + disk. Classification itself never writes; rejects only on transport failure.
   *
   * EXCEPTION: `hiveAdapter`'s survey opens with `HivemindService.sync()`, which pulls the clone
   * and read-modify-writes the shared HiveMind state file (`lastSynced`, and on a repo change the
   * pins too) as a side effect of staying current — that single write is real and is taken under
   * the same apply lock as every other write to that file (see `HiveAdapterDeps.withLock`). Every
   * other adapter's survey, and the rest of hiveAdapter's own survey after that call, holds to the
   * "never writes" rule literally.
   */
  survey(): Promise<Candidate[]>
  /**
   * Writes. Only ever called with a candidate this adapter returned as `clean`.
   *
   * MUST RE-DERIVE rather than trust the candidate: a survey result can be twenty minutes old,
   * and the world may have moved. A candidate is a proposal, never an authorization.
   */
  apply(c: Candidate): Promise<ApplyOutcome>
}
