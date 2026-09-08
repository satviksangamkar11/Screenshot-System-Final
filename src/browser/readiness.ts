import type { Page } from '../automation/types.js';
import { log } from '../util/logger.js';

/**
 * Application readiness detection.
 *
 * Enterprise Fiori applications can take well over a minute to render: the
 * launchpad shell appears almost immediately, then the application component
 * loads, resolves its route and fetches data. Capturing on a fixed delay
 * photographs an empty shell, so readiness is measured from what has actually
 * rendered rather than from elapsed time.
 */

export interface ReadinessSnapshot {
  /** UI5 controls that are registered *and* have a visible layout box. */
  renderedUi5: number;
  /** Of those, controls a user could interact with. */
  interactive: number;
  visibleInputs: number;
  visibleButtons: number;
  /**
   * Visible custom elements (tag names containing a hyphen, per the Custom
   * Elements spec) — covers web-component technologies the UI5 registry and
   * plain `input`/`button` counts above know nothing about.
   */
  visibleCustomElements: number;
  busyIndicators: number;
  visibleDialogs: number;
  title: string;
  bodyLength: number;
}

export interface ReadinessResult extends ReadinessSnapshot {
  ready: boolean;
  elapsedMs: number;
}

/** Measures what has rendered right now. */
export async function snapshotReadiness(page: Page): Promise<ReadinessSnapshot> {
  return page
    .evaluate(() => {
      const w = window as unknown as Record<string, any>;
      const sap = w['sap'];

      const visible = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const q = (s: string) => Array.from(document.querySelectorAll(s));

      /*
       * Collects registered controls across UI5 versions. `Element.registry`
       * is deprecated (1.120+) and is not exposed as a global on every
       * release, so the legacy core traversal must be tried as well — without
       * it this returned zero on a fully rendered page, which made the
       * readiness gate wait out its entire budget and then report
       * `interactive=0` for an application that was plainly on screen. The
       * discovery probe already collects both ways; readiness must agree with
       * it or the two disagree about whether the app exists.
       */
      const collect = (): any[] => {
        const out: any[] = [];
        try {
          const registry = sap?.ui?.core?.Element?.registry;
          if (registry?.forEach) {
            registry.forEach((el: any) => out.push(el));
            if (out.length) return out;
          }
        } catch {
          /* fall through to legacy traversal */
        }
        try {
          const core = sap?.ui?.getCore?.();
          const elements = core?.mElements;
          if (elements && typeof elements === 'object') {
            for (const key of Object.keys(elements)) out.push(elements[key]);
            if (out.length) return out;
          }
        } catch {
          /* fall through to the rendered-markup traversal */
        }
        // Pre-registry releases expose neither registry -- `mElements` lives
        // on the Core instance, not on the facade `sap.ui.getCore()` returns.
        // Their controls are reachable only through the rendered markup; see
        // `probeUi5Controls`, which this must agree with or the two disagree
        // about whether the application exists.
        try {
          const core = sap?.ui?.getCore?.();
          if (typeof core?.byId === 'function') {
            const seen = new Set<string>();
            for (const node of Array.from(
              document.querySelectorAll('[data-sap-ui]'),
            )) {
              const id = node.getAttribute('data-sap-ui');
              if (!id || seen.has(id)) continue;
              seen.add(id);
              const el = core.byId(id);
              if (el) out.push(el);
            }
          }
        } catch {
          /* no control registry reachable at all */
        }
        return out;
      };

      let renderedUi5 = 0;
      let interactive = 0;
      for (const el of collect()) {
        try {
          const dom = el.getDomRef?.();
          if (!dom) continue;
          const r = dom.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const style = getComputedStyle(dom);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          renderedUi5++;
          const type = String(el.getMetadata?.().getName?.() ?? '');
          if (
            /\.(Input|TextArea|Select|ComboBox|MultiComboBox|MultiInput|DatePicker|DateRangeSelection|DateTimePicker|TimePicker|CheckBox|RadioButton|Switch|FileUploader|UploadSet|Button|ToggleButton|IconTabFilter|SearchField|StepInput)$/.test(
              type,
            )
          ) {
            interactive++;
          }
        } catch {
          /* skip control */
        }
      }

      return {
        renderedUi5,
        interactive,
        visibleInputs: q('input').filter(visible).length,
        visibleButtons: q('button').filter(visible).length,
        visibleCustomElements: q('*')
          .filter((el) => el.tagName.includes('-'))
          .filter(visible).length,
        busyIndicators: q(
          '.sapUiLocalBusyIndicator, #sapUiBusyIndicator, .sapMBusyDialog, .sapUiBusy',
        ).filter(visible).length,
        visibleDialogs: q('.sapMDialog, .sapMPopover, [role="dialog"], dialog[open]').filter(
          visible,
        ).length,
        title: document.title,
        bodyLength: (document.body?.innerText || '').length,
      };
    })
    .catch(() => ({
      renderedUi5: 0,
      interactive: 0,
      visibleInputs: 0,
      visibleButtons: 0,
      visibleCustomElements: 0,
      busyIndicators: 0,
      visibleDialogs: 0,
      title: '',
      bodyLength: 0,
    }));
}

/**
 * Waits until the application has actually rendered something to work with.
 *
 * Ready means interactive controls or a dialog are on screen, nothing is busy,
 * and the count has stopped changing — so a partially-rendered form is not
 * mistaken for a finished one. Returns rather than throws when the budget runs
 * out, letting the caller record the state it did reach.
 */
export async function waitForAppReady(
  page: Page,
  timeoutMs: number,
  opts: { pollMs?: number; quietPolls?: number } = {},
): Promise<ReadinessResult> {
  const pollMs = opts.pollMs ?? 1500;
  const quietPolls = opts.quietPolls ?? 2;
  const started = Date.now();

  let stableCount = 0;
  let previousSignature = '';
  let announced = false;
  let last = await snapshotReadiness(page);

  while (Date.now() - started < timeoutMs) {
    last = await snapshotReadiness(page);

    /*
     * Content is detected from the DOM as well as from the UI5 registry. The
     * registry is unavailable on older UI5 releases — which is exactly the case
     * on an "old version" host — and relying on it alone makes a fully rendered
     * form look like an empty page.
     */
    const hasContent =
      last.interactive > 0 ||
      last.visibleDialogs > 0 ||
      last.visibleInputs > 0 ||
      last.visibleButtons >= 5 ||
      last.visibleCustomElements > 0;
    const settled = last.busyIndicators === 0;
    const signature =
      `${last.renderedUi5}:${last.interactive}:${last.visibleDialogs}:` +
      `${last.visibleInputs}:${last.visibleButtons}:${last.visibleCustomElements}`;

    if (hasContent && !announced) {
      log.debug(
        `  app content appeared after ${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
      announced = true;
    }

    if (hasContent && settled && signature === previousSignature) {
      stableCount++;
      if (stableCount >= quietPolls) {
        return { ...last, ready: true, elapsedMs: Date.now() - started };
      }
    } else {
      stableCount = 0;
    }

    previousSignature = signature;
    await page.waitForTimeout(pollMs);
  }

  log.warn(
    `application did not finish rendering within ${(timeoutMs / 1000).toFixed(0)}s ` +
      `(interactive=${last.interactive}, dialogs=${last.visibleDialogs}); continuing anyway`,
  );
  return { ...last, ready: false, elapsedMs: Date.now() - started };
}
