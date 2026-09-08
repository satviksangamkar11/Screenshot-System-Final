import type { Page } from './types.js';

/**
 * Interaction-side shadow DOM utilities.
 *
 * This is the designated module for shadowRoot access during interactions.
 * locator-shim.ts and fields.ts must not reference shadowRoot directly;
 * any shadow-piercing they need must go through exports here.
 *
 * Currently the mock fixture uses delegatesFocus:true so the existing fill
 * path in locator-shim.ts already reaches inner inputs without modification.
 * These exports exist so future call sites have a single, auditable home.
 */

/**
 * Focuses the first focusable element inside a host element's shadow root.
 *
 * For hosts with `delegatesFocus:true` this is usually unnecessary — the host's
 * own `.focus()` already delegates.  Use this for non-delegating hosts where
 * you need to place focus precisely inside the shadow before typing.
 *
 * Returns true when a focusable element was found and focused.
 */
export async function pierceToFocusable(
  page: Page,
  hostSelector: string,
): Promise<boolean> {
  return page
    .evaluate((sel: string) => {
      const host = document.querySelector(sel);
      if (!host) return false;
      const sr = (host as any).shadowRoot as ShadowRoot | null;
      if (!sr) return false;
      const inner = sr.querySelector<HTMLElement>(
        'input:not([type="hidden"]), textarea, select, [contenteditable="true"]',
      );
      if (!inner) return false;
      inner.focus();
      return true;
    }, hostSelector)
    .catch(() => false);
}

/**
 * Reads the current value of the first text input inside a host's shadow root.
 *
 * Useful for verifying that a fill operation reached the inner input when the
 * host element does not expose a `value` property of its own.
 */
export async function pierceReadValue(
  page: Page,
  hostSelector: string,
): Promise<string | null> {
  return page
    .evaluate((sel: string) => {
      const host = document.querySelector(sel);
      if (!host) return null;
      const sr = (host as any).shadowRoot as ShadowRoot | null;
      if (!sr) return null;
      const inner = sr.querySelector<HTMLInputElement>(
        'input:not([type="hidden"]), textarea',
      );
      return inner ? inner.value : null;
    }, hostSelector)
    .catch(() => null);
}
