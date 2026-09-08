/**
 * Re-exports the UI5 probe primitives from their new home in the technology
 * adapter, so callers outside `discovery/` (`interaction/`, `state/`) keep
 * working unchanged.
 */
export { hasUi5, probeUi5Controls, ui5Fingerprint, type Ui5RawControl } from './adapters/ui5.js';
