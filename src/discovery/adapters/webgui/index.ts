import type { TechnologyAdapter } from '../types.js';
import { registerExtraDenyCheck } from '../../../interaction/safety.js';
import { probeWebGui } from './probe.js';
import type { WgControl } from './probe.js';
import { classifyWebGui } from './classify.js';
import { matchesDenyLabel } from './safety.js';

/*
 * Plugs the title-based deny check into `mayClick`'s generic extension
 * point. Runs once, at module load — this module is only ever reached
 * through `adapters/registry.ts`, so the check is registered exactly when
 * the adapter itself becomes reachable.
 */
registerExtraDenyCheck((ctx, policy) => {
  if (!ctx.title) return null;
  const hit = matchesDenyLabel(ctx.title, policy.denyLabels);
  if (!hit) return null;
  return {
    allowed: false,
    reason: `button titled "${ctx.title}" matches deny rule "${hit}"`,
  };
});

/**
 * Technology adapter for WebGUI/ITS (the Internet Transaction Server
 * rendering of SAP GUI, a.k.a. "SAP GUI for HTML").
 *
 * Detected either by an `/its/webgui` URL segment (ITS's own routing
 * convention) or, when the URL doesn't say so directly (an app embedded in
 * a frame, for instance), by the rendering markers ITS itself always emits:
 * `M0:`-pattern coordinate ids and `ur*`-prefixed CSS classes.
 */
export const webguiAdapter: TechnologyAdapter<WgControl> = {
  async detect(page) {
    if (/\/its\/webgui/i.test(page.url())) return true;

    return page
      .evaluate(() => {
        if (document.querySelector('[id*="M0:"]')) return true;
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('[class]'))) {
          for (const token of Array.from(el.classList)) {
            if (/^ur[A-Z]/.test(token)) return true;
          }
        }
        return false;
      })
      .catch(() => false);
  },

  probe: probeWebGui,

  classify: classifyWebGui,

  // WebGUI ids encode screen coordinates and are reassigned on every
  // redraw; the UI5 view-renumbering fallback assumes an id shaped like
  // `__xmlview2--SomeId`, which is not what these ids look like at all, so
  // it is switched off rather than silently inherited.
  supportsIdSuffixFallback: false,
};
