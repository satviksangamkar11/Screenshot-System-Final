import type { PageShim } from './page-shim.js';
import type { LocatorShim } from './locator-shim.js';

/**
 * Type-only re-export standing in for Playwright's `Page`/`Locator`.
 *
 * The runtime object behind every `Page` value in this codebase is a
 * `PageShim` (built on the CDP transport in cdp-client.ts/cdp-session.ts),
 * cast once at construction in browser/manager.ts. Importing the type from
 * here instead of from `'playwright'` lets every traversal/interaction file
 * keep its own `Page`/`Locator` type annotations with zero change to their
 * logic, now that the `playwright` package is no longer a dependency.
 */
export type Page = PageShim;
export type Locator = LocatorShim;
