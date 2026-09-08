import type { Locator } from '../../automation/types.js';
import type { ControlDescriptor } from '../../types.js';
import {
  overlayBaseline,
  waitForOverlay,
  waitForOverlayContent,
} from '../overlay.js';
import type { HandlerContext, OpenResult } from './types.js';

/**
 * Attempts to click a value-help or dropdown trigger that lives inside a
 * shadow root (e.g. the icon button inside a `ui5-input[show-value-help]` web
 * component). Falls back to `page.keyboard.press('F4')` — the UI5-convention
 * shortcut for "open this field's picker" — when no shadow element matches.
 *
 * Returns true when the click or keypress was dispatched.
 */
async function shadowPierceOrF4(
  page: HandlerContext['page'],
  hostSelector: string,
  shadowQuery: string,
  timeoutMs: number,
): Promise<boolean> {
  const clicked = await page
    .evaluate(
      ([sel, query]: [string, string]) => {
        const host = document.querySelector(sel);
        if (!host) return false;
        const sr = (host as any).shadowRoot as ShadowRoot | null;
        if (!sr) return false;
        const btn = sr.querySelector<HTMLElement>(query);
        if (!btn) return false;
        btn.click();
        return true;
      },
      [hostSelector, shadowQuery] as [string, string],
    )
    .catch(() => false);

  if (clicked) return true;

  // F4 is UI5's universal "open picker" keyboard shortcut — works for both
  // the JavaScript framework controls and the @ui5/webcomponents library.
  const loc = page.locator(hostSelector).first();
  await loc.focus().catch(() => undefined);
  await page.keyboard.press('F4').catch(() => undefined);
  return true;
}

/**
 * Clicks whatever this control kind's trigger is and waits for its
 * overlay/picker to appear — the "open" half of select/date/valueHelp/
 * multiSelect, kept apart from the handlers so Manual mode can reuse exactly
 * this and stop there, instead of also auto-picking a value the way the
 * handlers do.
 */
export async function openControlOverlay(
  control: ControlDescriptor,
  ctx: HandlerContext,
  loc: Locator,
  selector: string,
): Promise<OpenResult> {
  const baseline = await overlayBaseline(ctx.page);

  switch (control.kind) {
    case 'select': {
      // A native <select> renders its list in the operating system's own
      // layer, which cannot be screenshotted or driven the same way.
      const isNative = await loc
        .evaluate((el: Element) => el.tagName === 'SELECT')
        .catch(() => false);
      if (isNative) return { opened: false, baseline, isNative: true };

      await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      const opened = await waitForOverlay(ctx.page, 3000, baseline);
      return { opened, baseline };
    }

    case 'multiSelect': {
      // Try the SAP framework CSS class first (sap.m.MultiComboBox / MultiInput).
      const arrow = ctx.page.locator(`${selector} .sapMInputBaseIconContainer`).first();
      if (await arrow.isVisible().catch(() => false)) {
        await arrow.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      } else {
        // Web components (@ui5/webcomponents) keep their arrow inside a shadow root.
        // Possible shadow selectors across library versions:
        //   ui5-multi-combobox: .ui5-multi-combobox-toggle-button, [icon=slim-arrow-down]
        //   ui5-multi-input:    .ui5-multi-input-toggle-button
        // Fall back to clicking the host, which delegates in most cases.
        const pierced = await shadowPierceOrF4(
          ctx.page,
          selector,
          '.ui5-multi-combobox-toggle-button, .ui5-multi-input-toggle-button, [class*="toggle-button"]',
          ctx.budgets.controlTimeoutMs,
        );
        if (!pierced) {
          await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
        }
      }
      const opened = await waitForOverlay(ctx.page, 3000, baseline);
      if (opened) await waitForOverlayContent(ctx.page, ctx.budgets.controlTimeoutMs, baseline);
      return { opened, baseline };
    }

    case 'valueHelp': {
      // SAP framework (sap.m.Input with showValueHelp): icon is in the light DOM.
      const trigger = ctx.page
        .locator(
          `${selector} .sapMInputValHelp, ${selector} .sapMInputValHelpInner, ` +
            `${selector} .sapUiIcon`,
        )
        .first();

      if (await trigger.isVisible().catch(() => false)) {
        await trigger.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      } else {
        // Web components: value-help icon lives inside the shadow root.
        // Real @ui5/webcomponents renders it as `.ui5-input-value-help-button`.
        // Also try F4 — UI5's universal picker-open shortcut.
        await shadowPierceOrF4(
          ctx.page,
          selector,
          '.ui5-input-value-help-button, [slot="value-help-icon"], [icon="value-help"]',
          ctx.budgets.controlTimeoutMs,
        );
      }

      const opened = await waitForOverlay(
        ctx.page,
        Math.min(ctx.budgets.controlTimeoutMs, 8000),
        baseline,
      );
      if (opened) await waitForOverlayContent(ctx.page, ctx.budgets.controlTimeoutMs, baseline);
      return { opened, baseline };
    }

    case 'date':
    case 'dateRange': {
      // A native `<input type="date">` (or datetime-local/month/week) opens
      // its picker in the browser's own OS-rendered layer, exactly like a
      // native <select>'s list above — there is no DOM overlay for
      // `waitForOverlay` to ever find, so both waits below would run to
      // their full timeout for nothing before falling through to the typed
      // fallback that actually works.
      const isNative = await loc
        .evaluate(
          (el: Element) =>
            el.tagName === 'INPUT' &&
            ['date', 'datetime-local', 'month', 'week'].includes(
              (el as HTMLInputElement).type,
            ),
        )
        .catch(() => false);
      if (isNative) return { opened: false, baseline, isNative: true };

      // SAP framework: calendar icon is in the light DOM.
      const icon = ctx.page.locator(`${selector} .sapUiIcon`).first();
      if (await icon.isVisible().catch(() => false)) {
        await icon.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      } else {
        // Web components: calendar icon lives in the shadow root.
        // Real @ui5/webcomponents: `.ui5-date-picker-toggle-button`.
        // Also handles ui5-time-picker and ui5-date-range-picker shadow buttons.
        const pierced = await shadowPierceOrF4(
          ctx.page,
          selector,
          '.ui5-date-picker-toggle-button, .ui5-time-picker-toggle-button, ' +
            '.ui5-date-range-picker-toggle-button, button[class*="toggle-button"]',
          ctx.budgets.controlTimeoutMs,
        );
        if (!pierced) {
          await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
        }
      }

      let opened = await waitForOverlay(
        ctx.page,
        Math.min(ctx.budgets.controlTimeoutMs, 8000),
        baseline,
      );

      // F4 is UI5's universal "open this control's picker" keyboard shortcut —
      // works across both the framework and the web-components library.
      if (!opened) {
        await loc.focus().catch(() => undefined);
        await ctx.page.keyboard.press('F4').catch(() => undefined);
        opened = await waitForOverlay(
          ctx.page,
          Math.min(ctx.budgets.controlTimeoutMs, 8000),
          baseline,
        );
      }
      return { opened, baseline };
    }

    default:
      return { opened: false, baseline };
  }
}
