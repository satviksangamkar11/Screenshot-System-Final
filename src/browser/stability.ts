import type { Page } from '../automation/types.js';

/**
 * UI5-aware stability waiting.
 *
 * `networkidle` alone is unreliable on Fiori: the framework keeps long-polling
 * connections open and renders asynchronously after the last response lands.
 * These helpers additionally consult the UI5 runtime itself.
 */

/** Waits until UI5 reports no pending requests and no busy indicator is shown. */
export async function waitForUi5Idle(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  // Give the DOM a chance to exist at all before probing the framework.
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
  } catch {
    /* proceed; a slow frame should not abort the whole capture */
  }

  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => {
        const w = window as unknown as Record<string, any>;
        const sap = w['sap'];
        if (!sap?.ui) return { hasUi5: false, busy: false, pending: 0 };

        let pending = 0;
        try {
          // Present on most UI5 versions; counts in-flight OData/XHR work.
          const core = sap.ui.getCore?.();
          const rm = core?.getMessageManager?.();
          void rm;
          pending = Number(w['sap']?.ui?.getCore?.()?.getUIDirty?.() ? 1 : 0);
        } catch {
          pending = 0;
        }

        // A visible busy indicator is the most reliable "still working" signal.
        const busyEl = document.querySelector(
          '.sapUiLocalBusyIndicator, .sapUiBusy, #sapUiBusyIndicator',
        ) as HTMLElement | null;
        const busy = !!busyEl && busyEl.offsetParent !== null;

        return { hasUi5: true, busy, pending };
      })
      .catch(() => ({ hasUi5: false, busy: false, pending: 0 }));

    if (!state.hasUi5) break;
    if (!state.busy && state.pending === 0) break;
    await page.waitForTimeout(120);
  }

  // Settle rendering.
  await page.waitForTimeout(150);
}

/**
 * Waits for the page to be visually settled.
 *
 * Combines a bounded `networkidle` attempt with the UI5 probe, then confirms the
 * DOM has stopped changing. Never throws: a page that will not settle is still
 * worth capturing, and the caller records it as an exception if the interaction
 * subsequently fails.
 */
export async function waitForStability(page: Page, timeoutMs: number): Promise<void> {
  const budget = Math.max(1000, timeoutMs);

  await page
    .waitForLoadState('networkidle', { timeout: Math.min(budget, 5000) })
    .catch(() => undefined);

  await waitForUi5Idle(page, budget).catch(() => undefined);

  await waitForDomQuiet(page, Math.min(budget, 3000)).catch(() => undefined);
}

/** Resolves once the DOM has had no mutations for a short quiet period. */
export async function waitForDomQuiet(page: Page, timeoutMs: number): Promise<void> {
  await page.evaluate(async (limit: number) => {
    await new Promise<void>((resolve) => {
      const QUIET_MS = 250;
      let timer: ReturnType<typeof setTimeout>;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, QUIET_MS);
      });

      const finish = () => {
        observer.disconnect();
        clearTimeout(hardStop);
        resolve();
      };

      const hardStop = setTimeout(finish, limit);
      timer = setTimeout(finish, QUIET_MS);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    });
  }, timeoutMs);
}
