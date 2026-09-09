import type { Page, Locator } from '../automation/types.js';
import type { ControlDescriptor } from '../types.js';
import type { ManualGate } from '../state/manualGate.js';
import type { RemoteControl } from '../server/remoteControl.js';
import {
  editableLocator,
  ensureInteractable,
  notFound,
  openControlOverlay,
  resolveSelector,
  reveal,
  type HandlerContext,
  type HandlerResult,
} from './handlers.js';
import { log } from '../util/logger.js';

/**
 * Manual data-entry step.
 *
 * Runs in place of a control's normal handler when the operator selected
 * Manual mode. Everything up to "found and interactable" is the exact same
 * pipeline Automatic mode uses (`resolveSelector`, `reveal`,
 * `ensureInteractable`) — this only replaces the fill itself: instead of
 * clicking/typing/selecting, it scrolls the control into view, highlights it
 * in the visible browser window so the operator can find it, and waits for
 * confirmation from the web UI before capturing the same way `ctx.capture()`
 * always has.
 */
export async function runManualStep(
  control: ControlDescriptor,
  ctx: HandlerContext,
  gate: ManualGate,
  remote?: RemoteControl,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) {
    gate.setItemStatus(control.dedupeKey, 'skipped');
    return notFound(control);
  }

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) {
    gate.setItemStatus(control.dedupeKey, 'waiting');
    return blocked;
  }

  await highlight(ctx.page, selector);

  /*
   * Dropdowns, calendars and lookups all hide a trigger the operator would
   * otherwise have to find and click themselves inside the live view before
   * they could even see what to pick from -- confirmed as a real friction
   * point on a live run (Company Code's value-help icon). Automatic mode
   * already knows exactly how to open each of these kinds; reused verbatim
   * via `openControlOverlay` (the same function, same selectors) so the
   * operator's very first frame already shows the open list/calendar/dialog,
   * ready to click into. Deliberately NOT extended to actionButton/
   * revealButton: those may perform a real action or reveal something
   * unknown, which manual mode leaves entirely to the operator's own
   * judgement rather than clicking on their behalf.
   */
  if (
    control.kind === 'select' ||
    control.kind === 'multiSelect' ||
    control.kind === 'valueHelp' ||
    control.kind === 'date' ||
    control.kind === 'dateRange'
  ) {
    await openControlOverlay(control, ctx, loc, selector).catch(() => undefined);
  } else if (control.kind === 'input' || control.kind === 'textarea') {
    /*
     * The text box in the web UI sends typed characters via
     * `page.keyboard.insertText`, which lands wherever the REAL page's DOM
     * focus currently is -- not wherever the operator is looking. Nothing
     * up to this point ever focuses the field itself (`highlight()` only
     * draws an outline), so a field became active, the operator typed
     * straight into the box, and the keystrokes landed nowhere (or on
     * whatever the previous field left focused) unless they first clicked
     * the exact right pixel inside the live image. Same fix as the overlay
     * auto-open above, for the same reason: resolve the real editable
     * element (the wrapper's inner <input>, same as Automatic mode's
     * `handleTextual`) and focus it automatically. Triple-click selects any
     * existing value so the operator's typed text replaces it, matching
     * `fill()`'s full-replace behaviour in Automatic mode, rather than
     * inserting in the middle of or after whatever was already there.
     */
    const target = await editableLocator(ctx.page, selector);
    try {
      await target.click({ timeout: ctx.budgets.controlTimeoutMs, clickCount: 3 });
    } catch (err) {
      // Previously swallowed silently, so a field that was never actually
      // focused looked identical to one waiting normally on the operator --
      // indistinguishable from the eventual "verification failed (empty)".
      // Surfacing it here narrows that down immediately.
      const preLabel = control.canonicalLabel || control.label || control.id;
      log.warn(
        `  [manual] could not pre-focus "${preLabel}" (${err instanceof Error ? err.message : String(err)}); ` +
          'operator will need to click the field directly in the live view',
      );
    }
  }

  const label = control.canonicalLabel || control.label || control.id;
  log.debug(`  [manual] waiting on operator for "${label}"`);

  await remote?.start();

  let action: 'submit' | 'skip';
  try {
    action = await gate.activate(control.dedupeKey);
  } finally {
    await remote?.stop();
    await unhighlight(ctx.page);
  }

  if (action === 'skip') {
    gate.setItemStatus(control.dedupeKey, 'skipped');
    return { documented: false, note: 'skipped by operator (manual mode)' };
  }

  // Verify the submitted value — with one automatic retry on failure.
  const verification = async (): Promise<{ valid: boolean; reason: string }> => {
    if (control.kind === 'input' || control.kind === 'textarea') {
      return await verifyFieldSubmission(ctx.page, control, selector);
    } else if (
      control.kind === 'select' ||
      control.kind === 'multiSelect' ||
      control.kind === 'valueHelp' ||
      control.kind === 'date' ||
      control.kind === 'dateRange'
    ) {
      return await verifySelectionSubmission(ctx.page, control, selector);
    }
    return { valid: true, reason: 'not-applicable' }; // no verification needed for other control kinds
  };

  let { valid: verified, reason } = await verification();

  if (!verified) {
    log.warn(
      `  [manual] ${control.kind} "${label}" verification failed (${reason}); offering one retry`,
    );
    gate.setItemStatus(control.dedupeKey, 'waiting');

    // Restart the live view for the retry
    await remote?.start();

    let retryAction: 'submit' | 'skip';
    try {
      // Reactivate the control exactly once — operator can correct their input
      retryAction = await gate.activate(control.dedupeKey);
    } finally {
      // Ensure remote always stops, even if reactivation fails
      await remote?.stop();
      await unhighlight(ctx.page);
    }

    if (retryAction === 'skip') {
      gate.setItemStatus(control.dedupeKey, 'skipped');
      return { documented: false, note: 'skipped by operator (on retry after verification failed)' };
    }

    // Try verification again
    ({ valid: verified, reason } = await verification());

    if (!verified) {
      log.error(
        `  [manual] ${control.kind} "${label}" verification failed on retry (${reason}); marking for manual review`,
      );
      gate.setItemStatus(control.dedupeKey, 'failed');
      return {
        documented: false,
        note: `verification failed on retry (${reason}) — field not documented, please review manually`,
      };
    }
  }

  await ctx.capture();
  gate.setItemStatus(control.dedupeKey, 'completed');
  return { documented: true };
}

const HIGHLIGHT_ATTR = 'data-ui-doc-engine-active';

/** Adds a visible outline so the operator can spot the active control. */
async function highlight(page: Page, selector: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((el: Element, attr: string) => {
      const target = el as HTMLElement;
      target.setAttribute(attr, '1');
      target.style.setProperty('outline', '3px solid #e11d48', 'important');
      target.style.setProperty('outline-offset', '2px', 'important');
    }, HIGHLIGHT_ATTR)
    .catch(() => undefined);
}

/** Removes the highlight added by `highlight()`. */
async function unhighlight(page: Page): Promise<void> {
  await page
    .locator(`[${HIGHLIGHT_ATTR}]`)
    .first()
    .evaluate((el: Element, attr: string) => {
      const target = el as HTMLElement;
      target.removeAttribute(attr);
      target.style.removeProperty('outline');
      target.style.removeProperty('outline-offset');
    }, HIGHLIGHT_ATTR)
    .catch(() => undefined);
}

/**
 * Verifies that a selection control has an actual selection made.
 * Checks that a value/option is selected in the real control, not just typed text.
 */
/**
 * Verifies that a selection control's value was actually set by the operator.
 * For input-backed UI5 controls (DatePicker, ValueHelp), checks the inner
 * `<input>.value`; falls back to wrapper's text content for display-only
 * controls like sap.m.Select.
 */
async function verifySelectionSubmission(
  page: Page,
  control: ControlDescriptor,
  selector: string,
): Promise<{ valid: boolean; reason: string }> {
  try {
    // First try to get the inner editable element (if one exists inside the wrapper).
    const inner = await editableLocator(page, selector);
    const result = await inner
      .evaluate((el: Element) => {
        // Native <select> element
        if (el instanceof HTMLSelectElement) {
          return {
            selected: el.selectedIndex >= 0 && el.value !== '',
            value: el.value,
            source: 'native-select',
          };
        }

        const target = el as HTMLInputElement | HTMLElement;

        // If it's an actual <input>, check its value (for DatePicker, ValueHelp Input, etc.)
        if (target instanceof HTMLInputElement) {
          const val = target.value?.trim() ?? '';
          return { selected: val !== '', value: val, source: 'input-value' };
        }

        // Fallback for wrapper elements (sap.m.Select, etc.): check for visible text
        // This handles controls where the selected value is displayed as text content.
        const text = (target as HTMLElement).innerText?.trim() ?? '';
        return { selected: text !== '', value: text, source: 'innertext' };
      })
      .catch(() => ({ selected: false, value: '', source: 'error' }));

    if (!result.selected) {
      return { valid: false, reason: `no value (${result.source})` };
    }

    return { valid: true, reason: 'ok' };
  } catch {
    return { valid: false, reason: 'verification-error' };
  }
}

/**
 * Diagnostic-only dump of everything relevant to why a text/numeric field's
 * verification might read empty: what the raw selector matched, what
 * editableLocator resolved it to, and where the page's own DOM focus
 * actually is at verification time. Pure logging — never affects control
 * flow, timing, or the verification result itself.
 */
async function logVerificationDiagnostics(
  page: Page,
  control: ControlDescriptor,
  selector: string,
  target: Locator,
): Promise<void> {
  const label = control.canonicalLabel || control.label || control.id;
  try {
    const matchedCount = await page
      .locator(selector)
      .count()
      .catch(() => -1);
    const editableCount = await page
      .locator(
        `${selector} input:not([type="hidden"]), ${selector} textarea, ${selector} [contenteditable="true"]`,
      )
      .count()
      .catch(() => -1);
    const resolved = await target
      .evaluate((el: Element) => {
        const e = el as HTMLInputElement | HTMLTextAreaElement;
        return {
          tagName: el.tagName,
          id: (el as HTMLElement).id || '',
          type: 'type' in e ? ((e as HTMLInputElement).type ?? '') : '',
          value: e.value ?? '',
        };
      })
      .catch(() => ({ tagName: 'n/a', id: 'n/a', type: 'n/a', value: 'n/a' }));
    const active = await page
      .evaluate(() => {
        const el = document.activeElement as (HTMLInputElement & HTMLTextAreaElement) | null;
        return { id: el?.id ?? '', value: el && 'value' in el ? (el.value ?? '') : '' };
      })
      .catch(() => ({ id: 'n/a', value: 'n/a' }));

    log.warn(
      `  [manual-verify] label="${label}" selector="${selector}" matchedBySelector=${matchedCount} ` +
        `editableDescendants=${editableCount} resolved.tagName=${resolved.tagName} resolved.id="${resolved.id}" ` +
        `resolved.type="${resolved.type}" resolved.value="${resolved.value}" ` +
        `activeElement.id="${active.id}" activeElement.value="${active.value}"`,
    );
  } catch (err) {
    log.warn(
      `  [manual-verify] diagnostics failed for "${label}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Verifies that a text/numeric field submission is valid.
 * Checks the actual `<input>` or `<textarea>` value via editableLocator,
 * so it works for both native elements and UI5 TextField wrappers.
 */
async function verifyFieldSubmission(
  page: Page,
  control: ControlDescriptor,
  selector: string,
): Promise<{ valid: boolean; reason: string }> {
  try {
    // Resolve through editableLocator to reach the actual <input> or <textarea>.
    const target = await editableLocator(page, selector);
    await logVerificationDiagnostics(page, control, selector, target);
    const result = await target
      .evaluate((el: Element) => {
        const e = el as HTMLInputElement | HTMLTextAreaElement;
        const value = e.value?.trim() ?? '';

        if (!value) {
          return { valid: false, reason: 'empty' };
        }

        // Check for client-side validation errors
        if ('validity' in e) {
          const validity = (e as HTMLInputElement).validity;
          if (validity && !validity.valid) {
            return {
              valid: false,
              reason: validity.valueMissing
                ? 'valueMissing'
                : validity.typeMismatch
                  ? 'typeMismatch'
                  : validity.patternMismatch
                    ? 'patternMismatch'
                    : 'invalid',
            };
          }
        }

        return { valid: true, reason: 'ok' };
      })
      .catch(() => ({ valid: false, reason: 'evaluate-error' }));

    return result;
  } catch {
    return { valid: false, reason: 'verification-error' };
  }
}
