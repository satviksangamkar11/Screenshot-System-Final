import type { Budgets } from '../config/schema.js';

/**
 * Exploration budgets.
 *
 * Enterprise Fiori screens are slow and deeply nested; without hard limits a
 * recursive crawl can run indefinitely. Every stop is recorded so the execution
 * report shows whether a run finished naturally or was cut short.
 */
export class BudgetTracker {
  private readonly startedAt = Date.now();
  private pagesVisited = 0;
  private readonly stops: string[] = [];

  constructor(private readonly budgets: Budgets) {}

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get budgetStops(): string[] {
    return [...this.stops];
  }

  get pages(): number {
    return this.pagesVisited;
  }

  countPage(): void {
    this.pagesVisited++;
  }

  /** True when the whole run must stop. */
  runExhausted(): boolean {
    if (this.elapsedMs >= this.budgets.maxRunMs) {
      this.note(`run wall-clock budget reached (${this.budgets.maxRunMs}ms)`);
      return true;
    }
    if (this.pagesVisited >= this.budgets.maxPages) {
      this.note(`page budget reached (${this.budgets.maxPages} pages)`);
      return true;
    }
    return false;
  }

  /** True when recursion may not go deeper. */
  depthExhausted(depth: number): boolean {
    if (depth >= this.budgets.maxDepth) {
      this.note(`depth budget reached (${this.budgets.maxDepth}) `);
      return true;
    }
    return false;
  }

  /** True when a single page has consumed its control budget. Unbounded unless configured. */
  controlsExhausted(processed: number): boolean {
    if (this.budgets.maxControlsPerPage === undefined) return false;
    if (processed >= this.budgets.maxControlsPerPage) {
      this.note(
        `per-page control budget reached (${this.budgets.maxControlsPerPage})`,
      );
      return true;
    }
    return false;
  }

  private note(reason: string): void {
    if (!this.stops.includes(reason)) this.stops.push(reason);
  }
}
