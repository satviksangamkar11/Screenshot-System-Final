import type { TechnologyAdapter } from '../types.js';
import { probeWebDynpro } from './probe.js';
import type { WdControl } from './probe.js';
import { classifyWebDynpro } from './classify.js';

/**
 * Technology adapter for Web Dynpro ABAP's Lightspeed renderer.
 *
 * Detected by the presence of `[lsdata]` elements with no UI5 runtime on the
 * page — a Fiori app can legitimately embed a Web Dynpro iframe/component,
 * and UI5, when present, is the more precise source of truth for anything it
 * already claims.
 */
export const webdynproAdapter: TechnologyAdapter<WdControl> = {
  async detect(page) {
    return page
      .evaluate(() => {
        const w = window as unknown as Record<string, any>;
        const hasUi5 = !!(w['sap'] && w['sap'].ui && (w['sap'].ui.getCore || w['sap'].ui.require));
        if (hasUi5) return false;
        return !!document.querySelector('[lsdata]');
      })
      .catch(() => false);
  },

  probe: probeWebDynpro,

  classify: classifyWebDynpro,

  // Web Dynpro ids (WD01, WD02, ...) are session-stable and already exact;
  // the UI5 view-renumbering fallback exists for a problem this ecosystem
  // doesn't have, so it is switched off rather than silently inherited.
  supportsIdSuffixFallback: false,
};
