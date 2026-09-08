import type { Page } from '../automation/types.js';
import { ADAPTERS } from './adapters/registry.js';
import { domFingerprint } from './adapters/aria-dom.js';

/**
 * Generic page-identity signals, built from the same adapter registry
 * discovery walks — so state identity and control discovery never disagree
 * about which technology is present. Neither export here names a
 * technology; the adapter-specific augmentation, when an adapter needs one,
 * lives entirely behind `TechnologyAdapter.fingerprint`.
 */

/**
 * The first framework-specific fingerprint that applies to this page, or
 * the generic DOM fingerprint when none does.
 *
 * Used for loop detection: a framework's own fingerprint is preferred
 * whenever one is available, since `domFingerprint` alone can under-detect
 * a state change a framework doesn't express through native markup.
 */
export async function primaryFingerprint(page: Page): Promise<string> {
  for (const adapter of ADAPTERS) {
    if (!adapter.fingerprint) continue;
    if (await adapter.detect(page)) return adapter.fingerprint(page);
  }
  return domFingerprint(page);
}

/**
 * Every framework-specific fingerprint plus the generic DOM one, combined.
 *
 * Used to decide whether clicking a button revealed something: unlike
 * `primaryFingerprint`, this doesn't stop at the first applicable adapter —
 * either signal changing counts as "revealed something", so a click that a
 * framework-specific fingerprint alone would miss (a plain DOM backdrop
 * appearing on an otherwise-framework page) is still caught by the generic
 * one layered in alongside it. Framework fingerprints are consulted
 * unconditionally, not gated by `detect()`, matching how a framework's own
 * fingerprint function already degrades safely when its technology isn't
 * present.
 */
export async function combinedFingerprint(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const adapter of ADAPTERS) {
    if (!adapter.fingerprint) continue;
    parts.push(await adapter.fingerprint(page));
  }
  parts.push(await domFingerprint(page));
  return parts.join('||');
}

/**
 * Counts currently visible interactive elements, technology-agnostic.
 *
 * Exists so `probeButton` can tell "revealed something" apart from
 * "collapsed something" — a fingerprint changing only proves the visible
 * control *set* is different, not whether it grew or shrank, and a button
 * that hides a whole navigation panel (a "Hide Navigation" toggle, an
 * accordion collapse) changes the fingerprint exactly as much as one that
 * opens a dialog. Confirmed against a real capture: such a button was
 * misclassified as `revealButton`, and every sidebar item still queued for
 * exploration then failed "element no longer in the page" one after another
 * — the run's whole remaining budget spent retrying controls that were never
 * coming back, instead of reaching the page's actual content.
 *
 * Covers the same breadth `aria-dom.ts`'s DOM probe does (inputs, buttons,
 * roles, links, disclosure toggles) rather than any one framework's control
 * types, so a shrink is caught whether the collapsing panel is built from
 * UI5 controls, plain anchors, or ARIA-only markup.
 */
export async function visibleControlCount(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      const selector =
        'input, textarea, select, button, [role="button"], [role="tab"], ' +
        '[role="slider"], [role="spinbutton"], [role="switch"], ' +
        '[role="treeitem"], [role="link"], [role="menuitem"], ' +
        'a[href]:not([href=""]), [aria-expanded], summary';
      let n = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        n++;
      }
      return n;
    })
    .catch(() => 0);
}
