import type { TechnologyAdapter } from '../types.js';
import { probeWebComponents } from './probe.js';
import type { WcControl } from './probe.js';
import { classifyWebComponent } from './classify.js';

const DETECT_SELECTOR =
  'ui5-input, ui5-textarea, ui5-select, ui5-combobox, ui5-multi-combobox, ' +
  'ui5-multi-input, ui5-date-picker, ui5-date-range-picker, ui5-time-picker, ' +
  'ui5-datetime-picker, ui5-checkbox, ui5-switch, ui5-radio-button, ' +
  'ui5-segmented-button, ui5-rating-indicator, ui5-step-input, ' +
  'ui5-slider, ui5-range-slider, ui5-file-uploader, ui5-upload-collection, ' +
  'ui5-button, ui5-toggle-button, ui5-link, ui5-tab';

/** Technology adapter for @ui5/webcomponents custom elements. */
export const webcomponentsAdapter: TechnologyAdapter<WcControl> = {
  async detect(page) {
    return page
      .evaluate((sel: string) => !!document.querySelector(sel), DETECT_SELECTOR)
      .catch(() => false);
  },

  probe: probeWebComponents,

  classify: classifyWebComponent,
};
