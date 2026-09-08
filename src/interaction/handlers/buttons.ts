import type { ControlDescriptor } from '../../types.js';
import { waitForStability } from '../../browser/stability.js';
import {
  closeOverlay,
  overlayBaseline,
  overlayCount,
  waitForOverlayContent,
} from '../overlay.js';
import { mayClick } from '../safety.js';
import { acknowledgeMessageDialogs, inspectTopDialog } from '../dialogs.js';
import { combinedFingerprint, visibleControlCount } from '../../discovery/fingerprint.js';
import { log } from '../../util/logger.js';
import {
  ensureInteractable,
  notFound,
  resolveSelector,
  reveal,
} from './resolve.js';
import type { HandlerContext, HandlerResult } from './types.js';

/**
 * Buttons, whose kind cannot be known without trying them.
 *
 * Fingerprints the page, clicks, and compares: new UI means this was a reveal
 * button (a documentation point); an unchanged page means it was a pure action
 * button (no point). Deny-listed buttons are never clicked at all.
 */
export async function probeButton(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const verdict = mayClick(control.label, ctx.safety, control.title);
  if (!verdict.allowed) {
    log.debug(`skipping unsafe button: ${verdict.reason}`);
    return {
      documented: false,
      reclassifiedAs: 'actionButton',
      note: `not clicked (${verdict.reason})`,
      safetySkipped: true,
    };
  }

  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return { ...notFound(control), reclassifiedAs: 'actionButton' };

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) return { ...blocked, reclassifiedAs: 'actionButton' };

  /*
   * A framework-specific fingerprint alone misses a plain DOM change on a
   * page with no such framework controls — a generic backdrop or panel
   * appearing, for instance — so `combinedFingerprint` layers the generic
   * DOM signal in as well. Either signal changing counts as "revealed
   * something".
   */
  const snapshot = async () => ({
    fingerprint: await combinedFingerprint(ctx.page),
    overlays: await overlayCount(ctx.page),
    controls: await visibleControlCount(ctx.page),
    url: ctx.page.url(),
  });

  // Snapshot before opening anything — see `overlayBaseline`. Kept separate
  // from `before.overlays` above: that raw count is what detects whether a
  // new overlay appeared at all; this identifies *which* ones existed
  // already, so the actions below can be scoped to whatever is new.
  const baseline = await overlayBaseline(ctx.page);
  const before = await snapshot();
  await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
  await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
  const after = await snapshot();

  const openedOverlay = after.overlays > before.overlays;
  const navigated = after.url !== before.url;
  const changed = after.fingerprint !== before.fingerprint;

  if (openedOverlay) {
    /*
     * A button that merely raises a validation message has not revealed a
     * workflow step, so it is an action button and earns no point.
     */
    const top = await inspectTopDialog(ctx.page);
    if (top?.isMessage) {
      await acknowledgeMessageDialogs(ctx.page, {
        max: 3,
        stabilityMs: ctx.budgets.stabilityTimeoutMs,
      });
      return {
        documented: false,
        reclassifiedAs: 'actionButton',
        note: `raised a message: ${top.title || top.text.slice(0, 60)}`,
      };
    }

    /*
     * The dialog appears before its rows arrive, exactly as for a dedicated
     * value-help field (see handleValueHelp): a button that turns out to
     * open a lookup dialog goes through this generic reveal path instead,
     * and without the same wait its evidence would show a busy indicator or
     * a "Loading......" placeholder rather than the settled result (real
     * rows, or a definitive "No data found").
     */
    await waitForOverlayContent(ctx.page, ctx.budgets.controlTimeoutMs, baseline);

    // A dialog is inline evidence on the parent page: photograph it, fill in
    // whatever it revealed while it is still open, then dismiss it.
    await ctx.capture();
    await ctx.exploreRevealed?.(baseline);
    await closeOverlay(ctx.page, undefined, baseline);
    await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
    return { documented: true, reclassifiedAs: 'revealButton', note: 'opened dialog' };
  }

  if (!navigated && changed) {
    /*
     * A fingerprint changing only proves the visible control set is
     * different — not whether it grew or shrank. A "Hide Navigation" toggle,
     * an accordion collapse, or any other panel-hiding button changes the
     * fingerprint exactly as much as a genuine reveal, and was being
     * documented as one: confirmed against a real capture where clicking
     * such a toggle was recorded as `revealButton`, and every sidebar
     * control still queued for exploration then failed "element no longer
     * in the page" one after another, burning the run's remaining time on
     * controls that were never coming back — nothing from the page's actual
     * content behind that sidebar was ever reached. See
     * `visibleControlCount`'s own note for the full story.
     *
     * A collapse is many controls disappearing at once, not a field or two
     * shifting position — the 60%-of-before / minimum-6 thresholds keep an
     * ordinary "one field's dependents redrew" case (a handful of controls
     * changing, not vanishing) from tripping this.
     */
    const shrank = before.controls >= 6 && after.controls <= before.controls * 0.6;
    if (shrank) {
      // Best-effort restore: click the same control again, since most such
      // toggles flip back on a second press. Not verified any further — an
      // app whose toggle does not restore on a second click is rare enough
      // that guarding against it isn't worth the extra round trip here, and
      // this is strictly better than leaving the run's queue depending on
      // controls this collapse has already removed.
      await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
      return {
        documented: false,
        reclassifiedAs: 'actionButton',
        note: `collapsed UI (${before.controls} -> ${after.controls} visible controls); not documented, restore attempted`,
      };
    }
  }

  if (navigated || changed) {
    // The destination is the evidence for this point; a genuine navigation is
    // additionally flagged so the explorer treats it as a real child page
    // (fully explored, then verified back) rather than in-place content.
    await ctx.capture();
    return {
      documented: true,
      reclassifiedAs: 'revealButton',
      note: navigated ? 'navigated to new page' : 'revealed new UI',
      ...(navigated ? { navigatedAway: true } : {}),
    };
  }

  return { documented: false, reclassifiedAs: 'actionButton', note: 'no visible change' };
}
