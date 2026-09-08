import type { TechnologyAdapter } from './types.js';
import { ui5Adapter } from './ui5.js';
import { webcomponentsAdapter } from './webcomponents/index.js';
import { webdynproAdapter } from './webdynpro/index.js';
import { webguiAdapter } from './webgui/index.js';
import { ariaDomAdapter } from './aria-dom.js';

/**
 * The single ordered list of technology adapters, consulted both by
 * discovery (`classifier.ts`) and by the generic fingerprinting helpers
 * (`discovery/fingerprint.ts`).
 *
 * Every family this engine documents — UI5, Web Components, Web Dynpro
 * ABAP, WebGUI/ITS — is registered here exactly once, in the order it is
 * tried: each of the framework-specific adapters can identify its own
 * controls precisely, so they run first; the ARIA/DOM adapter is the
 * always-last fallback, describing whatever nothing earlier already
 * claimed. Adding support for a new technology means adding one adapter to
 * this list — nothing outside an adapter's own folder needs to know its
 * name.
 */
export const ADAPTERS: TechnologyAdapter[] = [
  ui5Adapter,
  webcomponentsAdapter,
  webdynproAdapter,
  webguiAdapter,
  ariaDomAdapter,
];
