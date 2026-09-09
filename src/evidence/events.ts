import type { VersionId } from '../types.js';

/**
 * Capture-event bus.
 *
 * Mirrors `addLogSink` in util/logger.ts, but carries structured facts rather
 * than a formatted line: a running job needs to tell its web UI *what* was
 * documented, not just print it.
 *
 * The distinction that matters here is that an event is emitted only once the
 * screenshot behind a point is actually on disk — never when one is merely
 * requested. `EvidenceStore.capture()` records `Evidence` regardless of
 * whether the shot succeeded (a failed one is logged and the record still
 * kept), and `assembleDocument` later drops any point whose file is missing,
 * so "an Evidence record exists" is not the same claim as "this is in the
 * document". Only the second one is worth telling the operator about.
 *
 * The registry is process-wide rather than per-job, exactly like the logger's:
 * two jobs running at once would each see the other's captures, the same way
 * they already interleave in each other's `job.log`. Scoping either one
 * properly means threading a job id down through the whole capture pipeline,
 * so this deliberately matches the existing behaviour instead of introducing
 * a second, different notion of "which run is this".
 */

export interface CaptureEvent {
  /** Global sequence number within the run — the point's document order. */
  seq: number;
  version: VersionId;
  /** What was documented, as the operator knows it ("Payment Type"). */
  label: string;
  /** Image files this point actually put on disk (a Full Page point has several). */
  screenshots: number;
  at: number;
}

/** Receives every point whose evidence was confirmed written. */
export type CaptureSink = (event: CaptureEvent) => void;

const sinks = new Set<CaptureSink>();

export function addCaptureSink(sink: CaptureSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function emitCaptured(event: Omit<CaptureEvent, 'at'>): void {
  const full: CaptureEvent = { ...event, at: Date.now() };
  for (const sink of sinks) {
    try {
      sink(full);
    } catch {
      /* a failing sink must never break the run */
    }
  }
}
