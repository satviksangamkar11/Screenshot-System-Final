import type { CDPSession } from '../automation/cdp-session.js';

/**
 * Browser-side compatibility shims.
 *
 * Functions passed to `page.evaluate` are serialised to source and executed in
 * the page. Some TypeScript transforms (esbuild's `keepNames`, used by tsx)
 * rewrite function declarations to call a `__name` helper that exists only in
 * the bundler's own runtime, so the serialised source throws
 * `ReferenceError: __name is not defined` inside the browser.
 *
 * Defining a no-op `__name` in the page makes evaluated code work identically
 * whether it was run through tsx or compiled with tsc.
 *
 * The script is passed as a string deliberately: a function would itself be
 * subject to the same transform.
 */
const SHIM_SOURCE = `
globalThis.__name = globalThis.__name || function (fn) { return fn; };
globalThis.__defProp = globalThis.__defProp || Object.defineProperty;
`;

/**
 * Installs the shims for every document loaded in this session.
 *
 * `Page.addScriptToEvaluateOnNewDocument` is the direct CDP mechanism
 * Playwright's own `context.addInitScript` is built on — behavior is
 * identical, not approximated: the script re-runs on every subsequent
 * navigation, before any page script executes.
 */
export async function installBrowserShims(cdpSession: CDPSession): Promise<void> {
  await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM_SOURCE });
}
