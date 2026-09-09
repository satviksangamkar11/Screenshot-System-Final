import type { ControlKind } from '../types.js';

/**
 * Bridges the explorer's per-control loop to a human operator, for Manual
 * data entry mode.
 *
 * Decoupled from the HTTP layer the same way log streaming already is (see
 * `addLogSink` in util/logger.ts): the explorer knows only this interface,
 * and the web server supplies the concrete implementation that stores state
 * on a `Job` and resolves through an HTTP endpoint. This keeps the explorer
 * usable without a web server present, and keeps job/HTTP concerns out of the
 * traversal engine.
 */

export type ManualStatus = 'waiting' | 'in-progress' | 'completed' | 'skipped' | 'failed';

export interface ManualQueueItem {
  /** control.dedupeKey — stable across a page's re-discovery sweeps. */
  id: string;
  label: string;
  kind: ControlKind;
  section?: string;
  tab?: string;
  status: ManualStatus;
  /** For select/multiSelect/valueHelp controls: the actual available options. */
  options?: { value: string; label: string }[];
  /** For input/textarea controls: the underlying HTML input type (text, number, ...). */
  inputType?: string;
}

export interface ManualGate {
  /**
   * Adds any not-yet-seen items to the known queue (upsert, not replace).
   * Discovery runs in repeated sweeps as a page reveals more content, so this
   * is called once per sweep with whatever is newly pending; items already
   * known keep whatever status they've reached (in-progress/completed/
   * skipped) rather than being reset back to "waiting".
   */
  setQueue(items: ManualQueueItem[]): void;
  /** Marks one item's status without waiting (e.g. back to "waiting" on retry). */
  setItemStatus(id: string, status: ManualStatus): void;
  /**
   * Marks an item in-progress and blocks until the operator confirms it —
   * `submit` (filled) or `skip`.
   */
  activate(id: string): Promise<'submit' | 'skip'>;
  /** Clears the queue — called when the explorer moves on to a new page. */
  reset(): void;
}

/**
 * Reference implementation, independent of any job/HTTP state.
 *
 * The web server's job-bound gate (in server/jobs.ts) wraps one of these and
 * mirrors its queue onto the `Job` object for the HTTP layer to serialise.
 */
export class InMemoryManualGate implements ManualGate {
  private queue: ManualQueueItem[] = [];
  private pending = new Map<string, (action: 'submit' | 'skip') => void>();

  /** Called whenever the queue changes, so a host (the job) can mirror it. */
  onChange?: (queue: ManualQueueItem[], activeId: string | undefined) => void;

  private activeId: string | undefined;

  private notify(): void {
    this.onChange?.(this.queue, this.activeId);
  }

  setQueue(items: ManualQueueItem[]): void {
    const known = new Set(this.queue.map((q) => q.id));
    const added = items.filter((item) => !known.has(item.id));
    if (added.length === 0) return;
    this.queue = [...this.queue, ...added];
    this.notify();
  }

  /** Drops the queue entirely — called when the explorer moves to a new page. */
  reset(): void {
    this.queue = [];
    this.activeId = undefined;
    this.notify();
  }

  setItemStatus(id: string, status: ManualStatus): void {
    const item = this.queue.find((q) => q.id === id);
    if (item) item.status = status;
    this.notify();
  }

  async activate(id: string): Promise<'submit' | 'skip'> {
    this.setItemStatus(id, 'in-progress');
    this.activeId = id;
    this.notify();

    return new Promise<'submit' | 'skip'>((resolve) => {
      this.pending.set(id, resolve);
    });
  }

  /** Called by the HTTP endpoint when the operator clicks Submit/Skip. */
  resolve(id: string, action: 'submit' | 'skip'): boolean {
    const fn = this.pending.get(id);
    if (!fn) return false;
    this.pending.delete(id);
    if (this.activeId === id) this.activeId = undefined;
    fn(action);
    return true;
  }
}
