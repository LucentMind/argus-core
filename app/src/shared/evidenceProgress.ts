/**
 * Payload shapes for the `evidence:progress` / `evidence:queueProgress` IPC channels.
 *
 * Canonical home for these types: the main-process queue (`main/services/ingestQueue.ts`)
 * re-exports them rather than defining its own copies, and the preload bridge and renderer
 * components import them from here directly. Before this existed, the phase union was
 * hand-copied into the preload's inline callback types and into test files with nothing
 * keeping them in sync.
 */

export type EvidencePhase = 'indexing' | 'extracting' | 'done' | 'error'

export interface EvidenceProgressEvent {
  slug: string
  evidenceId: number
  phase: EvidencePhase
  fraction: number
}

export interface QueueProgressEvent {
  slug: string
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
}
