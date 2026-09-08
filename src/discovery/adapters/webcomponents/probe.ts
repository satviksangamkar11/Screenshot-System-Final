import type { Page } from '../../../automation/types.js';
import { walkShadowElements } from '../../shared/shadow-walk.js';
import type { RawControl } from '../types.js';
import type { WcRawControl } from './classify.js';

/** A ui5-* host element, extended with the fields `discoverControls()` needs. */
export interface WcControl extends WcRawControl, RawControl {}

const WC_SELECTOR =
  // text / numeric
  'ui5-input, ui5-textarea, ui5-step-input, ui5-slider, ui5-range-slider, ' +
  // dropdowns
  'ui5-select, ui5-combobox, ' +
  // multi-value
  'ui5-multi-combobox, ui5-multi-input, ' +
  // date / time
  'ui5-date-picker, ui5-time-picker, ui5-datetime-picker, ui5-date-range-picker, ' +
  // boolean toggles
  'ui5-checkbox, ui5-switch, ui5-rating-indicator, ' +
  // single-choice among N
  'ui5-radio-button, ui5-segmented-button, ' +
  // file uploads
  'ui5-file-uploader, ui5-upload-collection, ' +
  // tabs
  'ui5-tab, ' +
  // action / nav
  'ui5-button, ui5-toggle-button, ui5-link, ui5-menu-item, ui5-avatar, ' +
  'ui5-breadcrumbs-item, ui5-tree-item, ' +
  // tiles / cards
  'ui5-card';

/**
 * Discovers ui5-* web component host elements anywhere in the page, including
 * inside nested shadow roots.  Selectors always target the light-DOM host tag
 * so the interaction layer can locate elements with regular CSS selectors.
 */
export async function probeWebComponents(page: Page): Promise<WcControl[]> {
  const entries = await walkShadowElements(page, WC_SELECTOR);

  return entries
    .filter((e) => e.tagName.startsWith('ui5-'))
    .map((e, i): WcControl => {
      const domId = e.shadowDepth === 0 ? e.domId : e.shadowHostId;
      const selector =
        e.shadowDepth === 0 ? e.hostSelector : e.hostSelector;

      return {
        id: domId || `${e.tagName}-${i}`,
        domId,
        selector,
        label: e.label,
        text: e.text,
        section: e.section,
        domOrder: e.domOrder,
        required: e.required,
        alreadyExpanded: false,
        tagName: e.tagName,
        disabled:
          e.disabled ||
          e.attrs['disabled'] !== undefined ||
          e.attrs['readonly'] !== undefined,
        showValueHelp: e.attrs['show-value-help'] !== undefined,
        ...(e.attrs['type'] ? { inputType: e.attrs['type'] } : {}),
      };
    });
}
