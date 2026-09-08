import type { ControlKind } from '../../../types.js';

/**
 * WebGUI/ITS control classification.
 *
 * WebGUI (ITS — the Internet Transaction Server rendering of SAP GUI, also
 * called "SAP GUI for HTML") renders each ABAP dynpro field as HTML carrying
 * a `ur*`-prefixed CSS class ("Unified Rendering"). There is no live control
 * registry to introspect the way UI5's is — the mapping below is fixed at
 * discovery time from the rendered class plus a couple of structural
 * signals (native `<input>` type, a sibling F4 trigger).
 *
 * Reference: the SAP GUI Scripting API's `GuiComponent` taxonomy (help.sap.com
 * → SAP GUI for Windows → Development → Scripting API), which is the closest
 * documented enumeration of what an ABAP dynpro screen actually contains —
 * WebGUI renders the same screens, just through HTML instead of the desktop
 * client. Each branch below is commented with the GuiComponent type it
 * corresponds to.
 */

/** WebGUI-specific fields used during classification. */
export interface WgRawControl {
  /** The `ur*`-prefixed class token identifying this control's rendered kind. */
  urClass: string;
  /** Native `<input>` type attribute, when applicable. */
  inputType?: string;
  /** True when a value-help ("F4") sibling trigger button exists for this field. */
  hasValueHelp: boolean;
  disabled: boolean;
  readOnly: boolean;
}

export function classifyWebGui(c: WgRawControl): ControlKind {
  // GuiTextField / GuiCTextField with Changeable = False, or a disabled
  // ur*Dsbl variant — a value the user cannot act on.
  if (c.disabled || c.readOnly || c.urClass === 'urEdf2TxtDsbl') return 'readonly';

  // GuiCheckBox — identified structurally (native input type), same as every
  // other adapter, not by a rendering class.
  if (c.inputType === 'checkbox') return 'checkbox';

  // GuiRadioButton.
  if (c.inputType === 'radio') return 'radio';

  /*
   * GuiCTextField with a possible-entries ("F4") help attached. ITS renders
   * this as the text field plus an adjacent trigger button rather than as a
   * distinct HTML control, so the signal is structural (see `probe.ts`'s
   * sibling-button detection) rather than a distinct `ur*` class of its own.
   * Checked ahead of the plain-input branch below so a lookup field is never
   * misclassified as free text.
   */
  if (c.hasValueHelp) return 'valueHelp';

  switch (c.urClass) {
    // GuiTextField / GuiCTextField, enabled.
    case 'urEdf2TxtEnbl':
      return 'input';

    // GuiComboBox.
    case 'urCbo':
      return 'select';

    // GuiTab (a strip item of a GuiTabStrip).
    case 'urTab':
      return 'tab';

    default:
      // GuiButton / GuiToolbarControl — icon-only toolbar buttons and
      // labelled pushbuttons alike render under an `urBtn*` family
      // (`urBtnStd`, `urBtnIco`, ...); anything in that family is a button
      // whose reveal-vs-action nature is resolved the same click-and-diff
      // way as every other technology's buttons.
      if (c.urClass.startsWith('urBtn')) return 'actionButton';
      return 'unknown';
  }
}
