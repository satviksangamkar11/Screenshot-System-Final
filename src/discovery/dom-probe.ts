/**
 * Re-exports the DOM probe primitives from their new home in the ARIA/DOM
 * adapter, so callers outside `discovery/` (`interaction/`, `state/`) keep
 * working unchanged.
 */
export { probeDomControls, domFingerprint, type DomRawControl } from './adapters/aria-dom.js';
