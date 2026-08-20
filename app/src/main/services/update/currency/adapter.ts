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
  /** Reads network + disk. NEVER writes. Rejects only on transport failure. */
  survey(): Promise<Candidate[]>
  /**
   * Writes. Only ever called with a candidate this adapter returned as `clean`.
   *
   * MUST RE-DERIVE rather than trust the candidate: a survey result can be twenty minutes old,
   * and the world may have moved. A candidate is a proposal, never an authorization.
   */
  apply(c: Candidate): Promise<ApplyOutcome>
}
