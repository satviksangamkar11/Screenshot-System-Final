import type { ControlKind } from '../../../types.js';

/** Web-Dynpro-specific fields used during classification. */
export interface WdRawControl {
  controlType: string;
  disabled: boolean;
  readOnly: boolean;
  dataType: string;
  hasValueHelp: boolean;
}

/** Maps a Web Dynpro `lsdata` control type to its documentation kind. */
export function classifyWebDynpro(c: WdRawControl): ControlKind {
  if (c.disabled || c.readOnly) return 'readonly';

  switch (c.controlType) {
    case 'InputField':
      if (c.hasValueHelp) return 'valueHelp';
      if (c.dataType === 'DATE') return 'date';
      return 'input';
    case 'DropDownByKey':
    case 'DropDownByIndex':
      return 'select';
    case 'CheckBox':
      return 'checkbox';
    case 'RadioButton':
      return 'radio';
    case 'FileUpload':
      return 'fileUpload';
    case 'Button':
    case 'LinkToAction':
      return 'actionButton';
    case 'Tab':
      return 'tab';
    default:
      return 'unknown';
  }
}
