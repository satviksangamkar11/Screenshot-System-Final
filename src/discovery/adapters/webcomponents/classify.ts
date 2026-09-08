import type { ControlKind } from '../../../types.js';

/** Web-component-specific fields used during classification. */
export interface WcRawControl {
  tagName: string;
  disabled: boolean;
  showValueHelp: boolean;
}

/** Maps a ui5-* custom element to its documentation kind. */
export function classifyWebComponent(c: WcRawControl): ControlKind {
  if (c.disabled) return 'readonly';
  if (c.showValueHelp) return 'valueHelp';

  switch (c.tagName) {
    // ── text / numeric inputs ────────────────────────────────────────────────
    case 'ui5-input':
    case 'ui5-step-input':   // numeric spinner
    case 'ui5-slider':       // range slider (single handle)
    case 'ui5-range-slider': // two-handle slider
      return 'input';

    case 'ui5-textarea':
      return 'textarea';

    // ── dropdowns ────────────────────────────────────────────────────────────
    case 'ui5-select':
    case 'ui5-combobox':
      return 'select';

    // ── multi-value inputs ───────────────────────────────────────────────────
    case 'ui5-multi-combobox':
    case 'ui5-multi-input':  // token / tag input
      return 'multiSelect';

    // ── date / time ──────────────────────────────────────────────────────────
    case 'ui5-date-picker':
    case 'ui5-time-picker':
    case 'ui5-datetime-picker':
      return 'date';

    case 'ui5-date-range-picker':
      return 'dateRange';

    // ── boolean toggles ──────────────────────────────────────────────────────
    case 'ui5-checkbox':
    case 'ui5-switch':         // on/off toggle
    case 'ui5-rating-indicator': // star-rating (clickable)
      return 'checkbox';

    // ── single-choice among N ────────────────────────────────────────────────
    case 'ui5-radio-button':
    case 'ui5-segmented-button': // button-group (pick one)
      return 'radio';

    // ── file uploads ─────────────────────────────────────────────────────────
    case 'ui5-file-uploader':
    case 'ui5-upload-collection':
      return 'fileUpload';

    // ── tabs / navigation ────────────────────────────────────────────────────
    case 'ui5-tab':
      return 'tab';

    // ── action / navigation buttons ──────────────────────────────────────────
    case 'ui5-button':
    case 'ui5-toggle-button':
    case 'ui5-link':
    case 'ui5-menu-item':
    case 'ui5-avatar':          // can open a quick-view/contact popover
    case 'ui5-breadcrumbs-item': // navigates up the page hierarchy
    case 'ui5-tree-item':        // expand/collapse or select a hierarchy node
      return 'actionButton';

    // ── tiles / cards (Overview Page equivalents in the web-components library) ──
    case 'ui5-card':
      return 'revealButton';

    default:
      return 'unknown';
  }
}
