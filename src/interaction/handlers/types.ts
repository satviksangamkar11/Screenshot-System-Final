import type { Page } from '../../automation/types.js';
import type { ControlDescriptor, ControlKind } from '../../types.js';
import type { Budgets, SafetyPolicy } from '../../config/schema.js';
import type { TestDataProvider } from '../../testdata/provider.js';

/**
 * Shared types for the interaction handlers — one handler per control kind,
 * split across this directory. See `../handlers.ts`, the barrel that
 * re-exports this directory's public surface unchanged.
 *
 * Every handler follows the same contract:
 *   open()   - put the control into the state that should be photographed
 *   select() - apply a dummy value
 *   verify() - confirm the value landed
 *
 * The `open` step exists because the documented evidence is the *opened* state
 * (dropdown expanded, calendar showing, value-help dialog visible), not the
 * final filled field.
 */

export interface HandlerContext {
  page: Page;
  budgets: Budgets;
  safety: SafetyPolicy;
  testData: TestDataProvider;
  /** Captures the current screen as this control's evidence. */
  capture: () => Promise<void>;
  /**
   * Processes controls that an interaction has just revealed, while they are
   * still on screen. Used for dialogs, which are documented inline on the
   * parent page and whose own fields must be filled before the dialog closes.
   *
   * `baseline` is the set of overlays that already existed before this
   * control's own interaction opened anything — see `overlayBaseline` in
   * overlay.ts. Passing it through keeps the nested exploration scoped to the
   * overlay this interaction actually opened, not a leftover from an earlier
   * step that happens to still be on screen alongside it.
   */
  exploreRevealed?: (baseline: ReadonlySet<string>) => Promise<void>;
}

export interface HandlerResult {
  /** False when the control produced no evidence and should not be documented. */
  documented: boolean;
  /** Set when the control turned out to be a different kind than classified. */
  reclassifiedAs?: ControlKind;
  /** Human-readable note for the execution report. */
  note?: string;
  /**
   * Set when the interaction navigated to a genuinely different page (the URL
   * itself changed), as opposed to revealing a dialog or expanding something
   * in place. The caller must explore that destination as a real child page
   * and verify its way back before touching anything else on the current
   * page — an in-place UI change carries no such requirement.
   */
  navigatedAway?: boolean;
  /**
   * Set when the control was skipped for a reason that a later sweep could
   * resolve — it was hidden behind a collapsed panel, or covered by an overlay
   * that has since closed. Such a control must not be recorded as permanently
   * handled, or expanding the thing that was hiding it comes too late to help.
   */
  retryable?: boolean;
  /** Set when the control was a button the safety policy refused to click. */
  safetySkipped?: boolean;
}

export type Handler = (
  control: ControlDescriptor,
  ctx: HandlerContext,
) => Promise<HandlerResult>;

/** What opening a control's overlay/picker found. */
export interface OpenResult {
  opened: boolean;
  /** Overlays present before this open attempt — pass through to pick/close/explore. */
  baseline: ReadonlySet<string>;
  /** True for a native `<select>`: nothing renders as an overlay to open. */
  isNative?: boolean;
}
