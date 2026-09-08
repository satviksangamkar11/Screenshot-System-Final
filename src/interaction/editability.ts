import type { Locator, Page } from '../automation/types.js';
import { closeOverlay } from './overlay.js';

/**
 * Editability pre-check.
 *
 * The engine used to click and fill a control on faith, relying on
 * Playwright's own actionability wait to eventually time out if the control
 * turned out not to be interactable. Against a real system that produced
 * exactly the failure mode it looks like: one field's dropdown left an
 * overlay open that never fully closed, and every field after it — genuinely
 * fillable, correctly located — sat blocked behind that overlay and each spent
 * its own full 30-second budget failing for the same underlying reason.
 *
 * Checking first turns that into one fast, diagnosable skip instead of N
 * repeated timeouts, and gives the one case worth auto-recovering from (a
 * stuck overlay) a chance to clear before giving up.
 */

export interface EditabilityResult {
  ok: boolean;
  /** Human-readable cause, present only when `ok` is false. */
  reason?: string;
}

/**
 * Waits, within a short budget, until a control is actually interactable:
 * present, visible, enabled, not read-only, and not covered by another
 * element. Returns as soon as it is — this is not a fixed delay.
 *
 * A control found to be covered gets one attempt at clearing whatever is
 * covering it (the common case: a dropdown/picker overlay left open by the
 * previous field), then continues polling within the same budget.
 */
export async function waitUntilEditable(
  page: Page,
  locator: Locator,
  timeoutMs: number,
): Promise<EditabilityResult> {
  const deadline = Date.now() + Math.max(timeoutMs, 500);
  let lastReason = 'element not found';
  let overlayClearAttempted = false;
  let recentreAttempted = false;

  while (Date.now() < deadline) {
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      lastReason = 'element not present';
      await page.waitForTimeout(150);
      continue;
    }

    const state = await locator
      .evaluate((raw: Element) => {
        const el = raw as HTMLElement;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';

        const field = el as HTMLInputElement;
        const disabled =
          field.disabled === true || el.getAttribute('aria-disabled') === 'true';
        const readOnly =
          field.readOnly === true || el.getAttribute('aria-readonly') === 'true';

        let blockedBy: string | null = null;
        if (visible) {
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const top = document.elementFromPoint(cx, cy);
          const clear = !top || top === el || el.contains(top) || top.contains(el);
          if (!clear && top) {
            const cls = (top as HTMLElement).className;
            const firstClass = typeof cls === 'string' ? cls.split(' ')[0] : '';
            blockedBy = firstClass
              ? `${top.tagName.toLowerCase()}.${firstClass}`
              : top.tagName.toLowerCase();
          }
        }

        return { visible, disabled, readOnly, blockedBy };
      })
      .catch(() => null);

    if (!state) {
      lastReason = 'could not inspect element';
    } else if (!state.visible) {
      lastReason = 'not visible';
    } else if (state.disabled) {
      lastReason = 'disabled';
    } else if (state.readOnly) {
      lastReason = 'read-only';
    } else if (state.blockedBy) {
      lastReason = `covered by ${state.blockedBy}`;

      /*
       * A field sitting under a sticky header or footer is "covered" only
       * because of where it happens to be scrolled to. Centring it in the
       * viewport moves it clear of both, which is what a person would do —
       * and is why fields like Delivery Route were being skipped despite
       * being perfectly interactive.
       */
      if (!recentreAttempted) {
        recentreAttempted = true;
        await locator
          .evaluate((el: Element) =>
            el.scrollIntoView({ block: 'center', inline: 'center' }),
          )
          .catch(() => undefined);
        await page.waitForTimeout(150);
        continue;
      }

      if (!overlayClearAttempted) {
        overlayClearAttempted = true;
        await closeOverlay(page, 2000).catch(() => undefined);
        continue; // re-check immediately rather than burning the poll interval
      }
    } else {
      return { ok: true };
    }

    await page.waitForTimeout(200);
  }

  return { ok: false, reason: lastReason };
}
