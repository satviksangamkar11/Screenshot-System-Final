import type { Locator, Page } from '../../automation/types.js';
import type { ControlDescriptor } from '../../types.js';
import { waitUntilEditable } from '../editability.js';
import { log } from '../../util/logger.js';
import type { HandlerContext, HandlerResult } from './types.js';

/**
 * Locating a control and confirming it can be acted on.
 *
 * Every handler starts with the same three steps — resolve the selector,
 * scroll it into view, check it is actually interactable — and Manual mode
 * reuses exactly these, which is why they live apart from the handlers
 * themselves rather than inside any one of them.
 */

/**
 * Finds the selector that actually matches this control right now.
 *
 * The id captured at discovery can stop matching before the control is
 * reached: UI5 renumbers auto-generated view prefixes when a view is
 * re-instantiated, turning `#__xmlview2--DueDateId-inner` into a selector for
 * an element that no longer exists while the field itself is plainly on
 * screen. Falling back to the view-independent suffix recovers it.
 *
 * Returns null when neither form matches, which means the control is genuinely
 * gone rather than merely renamed.
 */
export async function resolveSelector(
  page: Page,
  control: ControlDescriptor,
): Promise<string | null> {
  const countOf = async (selector: string): Promise<number> =>
    page
      .locator(selector)
      .count()
      .catch(() => 0);

  /*
   * The view-independent selector is preferred whenever it identifies exactly
   * one element. A locator is resolved at action time, so a selector that does
   * not embed the volatile view number stays correct even if the view
   * renumbers between this check and the click or fill that follows — a race
   * that genuinely occurred, failing a field that was on screen the whole time.
   *
   * When the suffix matches several elements (two view instances briefly
   * mounted together), the exact id disambiguates and is used instead.
   */
  const label = control.canonicalLabel || control.label || control.id;

  if (control.fallbackSelector) {
    const stable = await countOf(control.fallbackSelector);
    if (stable === 1) {
      log.debug(`  [resolve] "${label}": using stable fallback selector (1 match)`);
      return control.fallbackSelector;
    }

    if (stable > 1) {
      if ((await countOf(control.selector)) > 0) {
        log.debug(
          `  [resolve] "${label}": fallback matched ${stable} elements, ` +
            `using exact selector to disambiguate`,
        );
        return control.selector;
      }
      log.debug(
        `  [resolve] "${label}": fallback matched ${stable} elements, exact selector matched 0 — using fallback anyway`,
      );
      return control.fallbackSelector;
    }
  }

  if ((await countOf(control.selector)) > 0) {
    log.debug(`  [resolve] "${label}": using exact selector (no usable fallback)`);
    return control.selector;
  }

  /*
   * Both selectors missed, but the element may simply be mid-re-render: a
   * message dialog close, a value-help confirm, or a dependent field redraw
   * can all destroy and recreate elements within a few hundred milliseconds.
   * A short wait followed by one retry avoids marking the control stale when
   * its replacement is about to appear — which previously caused twelve
   * consecutive "element no longer in the page" every time a message dialog
   * was acknowledged.
   */
  await page.waitForTimeout(1200);

  if (control.fallbackSelector) {
    const retryStable = await countOf(control.fallbackSelector);
    if (retryStable === 1) {
      log.debug(`  [resolve] "${label}": found after brief wait via fallback selector`);
      return control.fallbackSelector;
    }
    if (retryStable > 1 && (await countOf(control.selector)) > 0) {
      log.debug(`  [resolve] "${label}": found after brief wait via exact selector`);
      return control.selector;
    }
    if (retryStable > 0) {
      log.debug(`  [resolve] "${label}": found after brief wait via fallback (${retryStable} matches)`);
      return control.fallbackSelector;
    }
  }

  if ((await countOf(control.selector)) > 0) {
    log.debug(`  [resolve] "${label}": found after brief wait via exact selector`);
    return control.selector;
  }

  log.debug(`  [resolve] "${label}": neither exact nor fallback selector matched anything`);
  return null;
}

/** Scrolls a control into view so screenshots show it in context. */
export async function reveal(page: Page, selector: string): Promise<Locator> {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(80);
  return loc;
}

/** Result returned when a control can no longer be found at all. */
export function notFound(control: ControlDescriptor): HandlerResult {
  const label = control.canonicalLabel || control.label || control.id;
  log.warn(`  skipping "${label}": element no longer in the page`);
  /*
   * Not found right now does not mean gone for good. Selecting a value in
   * one field commonly triggers UI5 to re-render a whole cluster of dependent
   * fields at once -- new elements, same meaning -- and every other control
   * already queued for this sweep goes stale in that same instant, purely
   * because the queue was built from the DOM as it stood a moment earlier.
   * A real run against the live system showed exactly this: dozens of fields
   * failing "element no longer in the page" back to back, immediately after
   * the field ahead of them in the queue was filled -- not because the form
   * lost them, but because it had just redrawn them. Treating this as
   * retryable lets the sweep mechanism -- already built for "hidden behind a
   * collapsed panel", the same kind of here-now-gone-a-moment-later state --
   * pick each of them back up once the redraw has settled, instead of
   * recording the whole cluster as permanently handled and silently losing
   * it from the documentation. `attempts`/`MAX_ATTEMPTS` still bounds a
   * control that is truly gone to two tries, not unbounded retries.
   */
  return { documented: false, note: 'skipped: element not found', retryable: true };
}

/**
 * Resolves the element that actually accepts typing.
 *
 * A UI5 control's id belongs to its wrapper element, not to the `<input>`
 * inside it, so filling the wrapper fails. This returns the inner editable
 * element when the selector resolves to a wrapper, and the element itself when
 * it is already editable.
 */
export async function editableLocator(
  page: Page,
  selector: string,
): Promise<Locator> {
  const self = page.locator(selector).first();

  const isEditable = await self
    .evaluate((el: Element) => {
      const tag = el.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (el as HTMLElement).isContentEditable === true
      );
    })
    .catch(() => false);

  if (isEditable) return self;

  const inner = page
    .locator(
      `${selector} input:not([type="hidden"]), ` +
        `${selector} textarea, ` +
        `${selector} [contenteditable="true"]`,
    )
    .first();

  const hasInner = await inner
    .count()
    .then((n) => n > 0)
    .catch(() => false);

  return hasInner ? inner : self;
}

/**
 * Confirms a control can actually be interacted with before attempting to.
 *
 * Returns null when it is safe to proceed. Returns a skip result — no click,
 * no fill, no exception — when it is not: this is what turns "not editable"
 * into one fast, clearly-labelled skip instead of the full control timeout
 * expiring on a click that was never going to land, which is what happened,
 * repeatedly, when a leftover overlay blocked every field behind it.
 */
export async function ensureInteractable(
  control: ControlDescriptor,
  ctx: HandlerContext,
  locator: Locator,
): Promise<HandlerResult | null> {
  const result = await waitUntilEditable(
    ctx.page,
    locator,
    ctx.budgets.editabilityCheckMs,
  );
  if (result.ok) return null;

  const label = control.canonicalLabel || control.label || control.id;
  log.warn(`  skipping "${label}": not interactable (${result.reason})`);

  /*
   * "Not visible" and "covered by ..." describe the page as it is right now,
   * not the control itself: a field inside a collapsed panel, or one sitting
   * under a dialog that is about to be dismissed, reads exactly this way and
   * becomes perfectly fillable a moment later. Those are offered back for a
   * later sweep. "Disabled" and "read-only" are properties of the control and
   * are not retried.
   */
  const transient =
    result.reason === 'not visible' ||
    result.reason === 'element not present' ||
    (result.reason ?? '').startsWith('covered by');

  return {
    documented: false,
    note: `skipped: ${result.reason}`,
    ...(transient ? { retryable: true } : {}),
  };
}
