/**
 * Interaction handlers for every control kind.
 *
 * This barrel re-exports the handlers/ subdirectory to keep the public API
 * unchanged while allowing internal organization: types in types.ts, resolver
 * logic in resolve.ts, field handlers in fields.ts, button probe in buttons.ts,
 * and overlay-opener in open-overlay.ts. Consumer imports are unaffected.
 */

export type { HandlerContext, HandlerResult, Handler, OpenResult } from './handlers/types.js';

export {
  resolveSelector,
  reveal,
  notFound,
  editableLocator,
  ensureInteractable,
} from './handlers/resolve.js';

export {
  handleTextual,
  handleSelect,
  handleDate,
  handleValueHelp,
  handleMultiSelect,
  handleToggle,
  handleFileUpload,
} from './handlers/fields.js';

export { probeButton } from './handlers/buttons.js';

export { openControlOverlay } from './handlers/open-overlay.js';

// Registry and lookup
import type { ControlKind } from '../types.js';
import {
  handleTextual,
  handleSelect,
  handleDate,
  handleValueHelp,
  handleMultiSelect,
  handleToggle,
  handleFileUpload,
} from './handlers/fields.js';
import { probeButton } from './handlers/buttons.js';
import type { Handler } from './handlers/types.js';

const HANDLERS: Partial<Record<ControlKind, Handler>> = {
  input: handleTextual,
  textarea: handleTextual,
  select: handleSelect,
  date: handleDate,
  dateRange: handleDate,
  valueHelp: handleValueHelp,
  multiSelect: handleMultiSelect,
  checkbox: handleToggle,
  radio: handleToggle,
  fileUpload: handleFileUpload,
  revealButton: probeButton,
  actionButton: probeButton,
};

/** Returns the handler for a control kind, or null when it is not interactive. */
export function handlerFor(kind: ControlKind): Handler | null {
  return HANDLERS[kind] ?? null;
}
