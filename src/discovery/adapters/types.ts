/**
 * Re-exports the adapter contract from its home in `core/adapter.ts`, so
 * existing imports across the adapters (`ui5.ts`, `aria-dom.ts`,
 * `webcomponents/`) and `classifier.ts` keep working unchanged.
 */
export type { RawControl, TechnologyAdapter } from './core/adapter.js';
