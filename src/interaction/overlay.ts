import type { Locator, Page } from '../automation/types.js';
import { waitForStability } from '../browser/stability.js';
import { log } from '../util/logger.js';

/**
 * Helpers for the transient UI that dropdowns, calendars and value-help dialogs
 * put on screen. The engine's central rule is that this opened state is the
 * evidence, so opening reliably — and closing without side effects — matters.
 */

/** Selectors covering UI5 popups plus common plain-DOM equivalents. */
const OVERLAY_SELECTOR = [
  '.sapMDialog',
  '.sapMPopover',
  '.sapMSelectList',
  '.sapMComboBoxBasePicker',
  '.sapMMultiComboBoxPicker',
  '.sapMDP',
  '.sapMDatePickerDropdown',
  '.sapMValueHelpDialog',
  '.sapMSelectDialog',
  '[role="dialog"]',
  '[role="listbox"]',
  // Native <dialog> has an implicit dialog role that attribute selectors miss.
  'dialog[open]',
].join(', ');

/** No exclusions — every overlay-affecting call below defaults to this. */
export const NO_BASELINE: ReadonlySet<string> = new Set();

/** CSS.escape equivalent for building selectors in Node. */
function cssEscape(value: string): string {
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

/**
 * Identifies every currently visible overlay element.
 *
 * Framework popups (dialogs, popovers, select lists) always carry an id;
 * elements matched only by a generic role selector without one fall back to a
 * positional key, so they still participate in baseline comparison even
 * though that key is not stable across separate calls.
 */
async function overlayIds(page: Page): Promise<string[]> {
  return page
    .evaluate((sel: string) => {
      return Array.from(document.querySelectorAll(sel))
        .filter((el) => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = getComputedStyle(el as HTMLElement);
          return style.visibility !== 'hidden' && style.display !== 'none';
        })
        .map((el, i) => (el as HTMLElement).id || `__anon${i}`);
    }, OVERLAY_SELECTOR)
    .catch(() => [] as string[]);
}

/**
 * Snapshots which overlays already exist, before an interaction opens
 * anything new.
 *
 * This is the baseline every function below is scoped against. An overlay
 * present in it was on screen before the current interaction did anything —
 * a leftover from an earlier, already-completed step of the workflow — and
 * every helper here treats it as off-limits: not counted as "open" for the
 * purpose of deciding whether this interaction's own popup appeared, not
 * searched for an option to select, not closed. Without this, a dialog left
 * over from three steps ago is indistinguishable from the one a field just
 * opened, and an unrelated interaction's cleanup can end up pressing Escape
 * into it or clicking one of its rows — silently altering state this
 * interaction never touched. This generalises to any leftover overlay in any
 * application; nothing here is specific to one dialog or one field.
 */
export async function overlayBaseline(page: Page): Promise<ReadonlySet<string>> {
  const ids = await overlayIds(page);
  if (ids.length) {
    log.debug(`  [overlay] baseline before this interaction: ${ids.join(', ')}`);
  }
  return new Set(ids);
}

/** Counts visible overlays not present in `baseline`. */
export async function overlayCount(
  page: Page,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<number> {
  const ids = await overlayIds(page);
  return ids.filter((id) => !baseline.has(id)).length;
}

/** Returns true once an overlay absent from `baseline` is visible. */
export async function isOverlayOpen(
  page: Page,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<boolean> {
  return (await overlayCount(page, baseline)) > 0;
}

/** Builds a `:not(#id)` chain excluding every id in `baseline`. */
function excludeBaseline(baseline: ReadonlySet<string>): string {
  return [...baseline]
    .filter((id) => !id.startsWith('__anon'))
    .map((id) => `:not(#${cssEscape(id)})`)
    .join('');
}

/**
 * Filters selectors to those inside a currently open, non-baseline overlay.
 *
 * While a modal dialog is open, only the dialog's own fields are reachable, so
 * a nested exploration must not attempt the page behind it — and must not
 * attempt a leftover dialog from an earlier step either, see `overlayBaseline`.
 */
export async function selectorsInsideOverlay(
  page: Page,
  selectors: string[],
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<Set<string>> {
  const inside = await page
    .evaluate(
      ({ sel, list, baselineIds }: { sel: string; list: string[]; baselineIds: string[] }) => {
        const baselineSet = new Set(baselineIds);
        const overlays = Array.from(document.querySelectorAll(sel)).filter((el) => {
          if (baselineSet.has((el as HTMLElement).id)) return false;
          const rect = (el as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (overlays.length === 0) return [] as string[];

        return list.filter((s) => {
          let el: Element | null = null;
          try {
            el = document.querySelector(s);
          } catch {
            return false;
          }
          if (!el) return false;
          return overlays.some((o) => o.contains(el as Node));
        });
      },
      { sel: OVERLAY_SELECTOR, list: selectors, baselineIds: [...baseline] },
    )
    .catch(() => [] as string[]);

  return new Set(inside);
}

/** Waits for an overlay absent from `baseline` to appear, returning whether one did. */
export async function waitForOverlay(
  page: Page,
  timeoutMs: number,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOverlayOpen(page, baseline)) {
      const ids = await overlayIds(page);
      const newIds = ids.filter((id) => !baseline.has(id));
      log.debug(`  [overlay] new overlay appeared: ${newIds.join(', ') || '(unidentified)'}`);
      // Let the popup finish animating so the screenshot is not mid-transition.
      await page.waitForTimeout(250);
      return true;
    }
    await page.waitForTimeout(100);
  }
  log.debug(`  [overlay] no new overlay appeared within ${timeoutMs}ms`);
  return false;
}

/**
 * Waits for a non-baseline overlay to finish loading its contents.
 *
 * A value-help dialog appears immediately but fetches its rows afterwards,
 * showing a busy indicator and a placeholder row ("Loading......") in the
 * meantime. Selecting during that window picks the placeholder instead of real
 * data, and photographs an empty table as the evidence. "Settled" here means
 * the busy-check reported not-busy on two consecutive polls, not merely once
 * -- see `stableNotBusy` below. Returns whether the overlay settled within
 * the budget.
 */
/**
 * The visibility predicate `waitForOverlayContent` needs, as pure data in →
 * boolean out. Mirrors `LocatorShim.isVisible()` exactly (the repo's
 * canonical check: box size, visibility, display, opacity, pointer-events) --
 * confirmed from a live DOM dump where SAPUI5 hides a busy indicator via
 * `visibility: hidden` while leaving its layout box (and thus non-zero
 * `getBoundingClientRect()` dimensions) intact, so box size alone cannot
 * tell it apart from a genuinely active one.
 *
 * Exported so this exact logic can be unit-tested without a browser. The
 * `page.evaluate()` closure below cannot call this function directly -- CDP
 * serialises that closure to run standalone in the browser's own JS realm,
 * with no access to this module's outer scope -- so it re-implements the
 * same five conditions inline instead. The two must be kept in sync by hand;
 * this function is the one covered by tests, and is what a change to either
 * should be checked against.
 */
export function isVisibleMeasurement(m: {
  width: number;
  height: number;
  visibility: string;
  display: string;
  opacity: string;
  pointerEvents: string;
}): boolean {
  return (
    m.width > 0 &&
    m.height > 0 &&
    m.visibility !== 'hidden' &&
    m.display !== 'none' &&
    m.opacity !== '0' &&
    m.pointerEvents !== 'none'
  );
}

/** How many consecutive not-busy polls `waitForOverlayContent` requires before treating an overlay as settled. */
export const STABLE_NOT_BUSY_THRESHOLD = 2;

/**
 * Pure transition function for the stabilization counter: a busy poll resets
 * it to zero, a not-busy poll advances it. Settled is `count >=
 * STABLE_NOT_BUSY_THRESHOLD`. Exported so the sequencing (busy → not-busy →
 * busy → not-busy → not-busy settles only after the *second* trailing
 * not-busy, not the first) can be unit-tested directly, independent of any
 * browser or timing.
 */
export function nextStableNotBusyCount(current: number, busyNow: boolean): number {
  return busyNow ? 0 : current + 1;
}

export async function waitForOverlayContent(
  page: Page,
  timeoutMs: number,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  /*
   * The busy-check disappearing once is not proof the content has settled --
   * a framework that re-renders progressively (an interim row set, then the
   * final one) can pass a single not-busy read while still mid-transition.
   * Requiring it on two consecutive polls, and resetting to zero the instant
   * busy reappears, catches that without turning this into a fixed extra
   * delay: a dialog that is genuinely done reports not-busy twice in a row
   * immediately, while one that flickers back to busy keeps being held until
   * it actually stops. See `nextStableNotBusyCount`.
   */
  let stableNotBusy = 0;

  while (Date.now() < deadline) {
    const busy = await page
      .evaluate(
        ({ sel, baselineIds }: { sel: string; baselineIds: string[] }) => {
          const baselineSet = new Set(baselineIds);
          // Mirrors `isVisibleMeasurement` above -- see that function's
          // comment for why this cannot simply call it instead.
          const visible = (el: Element) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            const style = getComputedStyle(el as HTMLElement);
            return (
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              style.opacity !== '0' &&
              style.pointerEvents !== 'none'
            );
          };
          const overlays = Array.from(document.querySelectorAll(sel)).filter(
            (el) => !baselineSet.has((el as HTMLElement).id) && visible(el),
          );
          if (overlays.length === 0) return false;

          return overlays.some((o) => {
            /*
             * All four busy signals are gated on `visible()`, `aria-busy`
             * included -- confirmed necessary from a live DOM dump where
             * `aria-busy="true"` sat on a wrapper whose own busy layer
             * already carried `sapUiLocalBusyIndicatorFade` (SAPUI5's
             * fade-*out* class) while the real data had already rendered
             * beneath it. An attribute that can keep reading "true" on a
             * node that is visually gone -- or on its way to being gone --
             * must not be trusted on existence alone the way the other three
             * checks already aren't; without this, `aria-busy` lingering past
             * the point of actual busy-ness would hold every value-help
             * interaction in this app to its full timeout regardless of how
             * fast the data actually arrived.
             * `sap.m.Table`'s own busy indicator -- rendered for exactly this
             * "value-help dialog fetching its rows" case -- carries neither
             * `aria-busy` nor either of the two pre-existing classes; it is
             * `.sapMBusyIndicator` (`.sapMTableSelectDialogBusyIndicator`
             * specifically inside a SelectDialog) with `role="progressbar"`,
             * also confirmed from that same dump. `role="progressbar"` is the
             * ARIA-standard role for any busy spinner, framework or
             * hand-built, so it generalises the same way the row-selection
             * roles elsewhere in this file do.
             */
            if (
              Array.from(
                o.querySelectorAll(
                  '[aria-busy="true"], .sapUiLocalBusyIndicator, .sapUiBlockLayer, .sapMBusyIndicator, [role="progressbar"]',
                ),
              ).some(visible)
            ) {
              return true;
            }
            /*
             * Placeholder row rendered while data is still on its way.
             * Tested per line, not against the overlay's whole `innerText`:
             * anchoring the old regex to the very end of that combined string
             * only matched when "Loading......" happened to be the last text
             * in the DOM -- confirmed on a live capture where the dialog's own
             * footer ("Cancel") sits after the loading row, so the combined
             * text actually ends in "...Loading......\nCancel" and never
             * matched, letting the screenshot and the row search both run
             * against a table that had not loaded yet. Matching each line on
             * its own is exact rather than substring-based so a real business
             * label such as "Loading Point" -- a legitimate SAP logistics term
             * this must not be confused with -- can never be mistaken for the
             * placeholder: its line is "Loading Point", which does not match
             * "loading" followed only by optional dots and nothing else.
             */
            const lines = ((o as HTMLElement).innerText || '')
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean);
            return lines.some((line) => /^loading\s*\.{0,}$/i.test(line));
          });
        },
        { sel: OVERLAY_SELECTOR, baselineIds: [...baseline] },
      )
      .catch(() => false);

    stableNotBusy = nextStableNotBusyCount(stableNotBusy, busy);
    if (stableNotBusy >= STABLE_NOT_BUSY_THRESHOLD) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * Closes a non-baseline overlay without committing a change.
 *
 * Prefers Escape, which UI5 treats as cancel, and falls back to an explicit
 * Cancel/Close control scoped to non-baseline overlays only. Never clicks
 * OK/Select, so that closing an overlay the engine merely inspected does not
 * alter application state.
 *
 * Returns immediately, doing nothing at all, when the only overlay left open
 * is one already present in `baseline` — there is nothing this interaction
 * opened left to close, and pressing Escape or clicking into a leftover
 * dialog from an earlier step is exactly the unscoped action that let a
 * later, unrelated interaction's cleanup silently act on state it never
 * touched.
 */
export async function closeOverlay(
  page: Page,
  timeoutMs = 4000,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<void> {
  if (!(await isOverlayOpen(page, baseline))) {
    const preExisting = await overlayIds(page);
    log.debug(
      preExisting.length
        ? `  [overlay] closeOverlay: nothing new to close (only pre-existing ${preExisting.join(', ')} present, left untouched)`
        : `  [overlay] closeOverlay: nothing open, no-op`,
    );
    return;
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(200);
  if (!(await isOverlayOpen(page, baseline))) {
    log.debug('  [overlay] closeOverlay: closed via Escape');
    return;
  }

  const exclude = excludeBaseline(baseline);
  const cancel = page
    .locator(
      `.sapMDialog${exclude} button:has-text("Cancel"), .sapMDialog${exclude} button:has-text("Close"), ` +
        `[role="dialog"]${exclude} button:has-text("Cancel"), [role="dialog"]${exclude} button:has-text("Close"), ` +
        `dialog[open]${exclude} button:has-text("Cancel"), dialog[open]${exclude} button:has-text("Close")`,
    )
    .first();
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    if (!(await isOverlayOpen(page, baseline))) {
      log.debug('  [overlay] closeOverlay: closed via Cancel/Close button');
    }
  }

  /*
   * Matching "Cancel"/"Close" by English text -- the only option before this
   * point -- cannot dismiss a dialog whose UI runs in another display
   * language: confirmed on a live capture where a value-help dialog's own
   * button text is localized, so neither Escape nor the text match above
   * closed it, and the dialog's block layer (`.sapUiBLy`), which covers the
   * *entire* page rather than just the dialog, then silently failed every
   * remaining control for the rest of the branch -- baseline scoping only
   * keeps a later interaction from mistaking a leftover dialog for its own,
   * it does nothing about that dialog's block layer physically intercepting
   * every click on the page behind it. Calling the control's own `close()`
   * through the UI5 API sidesteps button text and language entirely.
   */
  if (await isOverlayOpen(page, baseline)) {
    const closedViaApi = await closeViaUi5Api(page, baseline);
    await page.waitForTimeout(200);
    if (closedViaApi && !(await isOverlayOpen(page, baseline))) {
      log.debug('  [overlay] closeOverlay: closed via UI5 control API');
    }
  }

  if (await isOverlayOpen(page, baseline)) {
    log.debug(
      '  [overlay] closeOverlay: still open after Escape, Cancel and the UI5 API — leaving it ' +
        '(baseline scoping keeps later interactions from mistaking it for their own, but its ' +
        'block layer, if any, may still cover the page)',
    );
  }

  await waitForStability(page, timeoutMs).catch(() => undefined);
}

/**
 * Closes a non-baseline overlay through the UI5 control's own `close()`
 * method, resolved via `sap.ui.getCore().byId()` -- confirmed functional
 * (though deprecated since 1.119) on both target landscapes, old and new.
 * This is the only dismissal path that does not depend on the dialog's
 * button text, so it works regardless of the application's display
 * language. Returns whether a close() call was actually made.
 */
async function closeViaUi5Api(
  page: Page,
  baseline: ReadonlySet<string>,
): Promise<boolean> {
  return page
    .evaluate(
      ({ sel, baselineIds }: { sel: string; baselineIds: string[] }) => {
        const baselineSet = new Set(baselineIds);
        const core = (window as any).sap?.ui?.getCore?.();
        if (!core?.byId) return false;

        const overlays = Array.from(document.querySelectorAll(sel)).filter((el) => {
          if (baselineSet.has((el as HTMLElement).id)) return false;
          const rect = (el as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

        let closed = false;
        for (const el of overlays) {
          const id = (el as HTMLElement).id;
          if (!id) continue;
          const control = core.byId(id);
          if (control && typeof control.close === 'function') {
            control.close();
            closed = true;
          }
        }
        return closed;
      },
      { sel: OVERLAY_SELECTOR, baselineIds: [...baseline] },
    )
    .catch(() => false);
}

/**
 * Selects the first usable option inside a non-baseline overlay.
 *
 * Used by dropdowns, multi-selects and value-help dialogs, all of which need a
 * *valid* value rather than arbitrary text. Returns the chosen text, or null.
 * Every selector excludes `baseline` ids, so a leftover dialog from an
 * earlier, already-completed step can never be mistaken for the popup this
 * field just opened — the broadest tiers here (`.sapMDialog li` and similar)
 * are exactly the ones that would otherwise match anything dialog-shaped
 * still on screen, baseline or not.
 */
/** One row candidate found inside a non-baseline overlay: where to click, its label, and which tier found it. */
export interface RowCandidate {
  locator: Locator;
  text: string;
  /** The selector tier that matched this row — carried so a failure can name it. */
  source: string;
}

/**
 * Describes what a non-baseline overlay actually contains, for when no row
 * candidate was found at all.
 *
 * "No selectable row" on its own cannot distinguish "the dialog never opened"
 * from "the dialog is open and full of rows none of the tiers recognise" —
 * two failures with completely different fixes. This reports the raw counts
 * per row-shape so the next run says which one it is instead of leaving it
 * to be guessed at.
 */
async function describeOverlayContents(
  page: Page,
  baseline: ReadonlySet<string>,
): Promise<string> {
  return page
    .evaluate(
      ({ sel, baselineIds }: { sel: string; baselineIds: string[] }) => {
        const baselineSet = new Set(baselineIds);
        const visible = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const s = getComputedStyle(el as HTMLElement);
          return s.visibility !== 'hidden' && s.display !== 'none';
        };
        const overlays = Array.from(document.querySelectorAll(sel)).filter(
          (el) => !baselineSet.has((el as HTMLElement).id) && visible(el),
        );
        if (overlays.length === 0) return 'no non-baseline overlay is open';

        return overlays
          .map((o) => {
            const id = (o as HTMLElement).id || '(no id)';
            const n = (q: string) => o.querySelectorAll(q).length;
            const text = ((o as HTMLElement).innerText || '').replace(/\s+/g, ' ').slice(0, 120);
            return (
              `${id}[class="${(o as HTMLElement).className}"]: ` +
              `tbody tr=${n('tbody tr')}, li=${n('li')}, ` +
              `[role=row]=${n('[role="row"]')}, [role=option]=${n('[role="option"]')}, ` +
              `ui5-table-row=${n('ui5-table-row')}, text="${text}"`
            );
          })
          .join(' | ');
      },
      { sel: OVERLAY_SELECTOR, baselineIds: [...baseline] },
    )
    .catch(() => '(could not inspect overlay)');
}

/**
 * Finds selectable-looking rows inside a non-baseline overlay, in priority
 * order, without clicking anything.
 *
 * Row markup differs by which SAPUI5 table technology renders the picker's
 * results: `sap.m.Table` (ColumnListItem) produces a real `<table><tbody><tr>`,
 * while `sap.ui.table.Table`/`TreeTable`/`AnalyticalTable` (used by
 * `sap.ui.mdc` grid-type value helps among others) render virtualised
 * `div[role="row"]` rows with no `<table>` element at all -- confirmed on a
 * live capture where a grid-type value-help dialog opened and photographed
 * correctly but every earlier tier missed it, leaving the field permanently
 * empty. `[role="row"]` is the ARIA grid pattern both `sap.ui.table.*` and
 * hand-built grids follow, so it generalises across any such table rather
 * than matching one control class; `:has([role="columnheader"])` excludes
 * the header row, which carries the same `role="row"` on its own container in
 * that pattern.
 *
 * Framework-class tiers here (`.sapMSelectList`, `.sapMValueHelpDialog`, ...)
 * are kept because they are the actual SAPUI5 framework's own CSS classes --
 * present on every app that uses that control, not something specific to one
 * app or field -- and are proven by the many captures where selection already
 * works. Only a container class with no supporting evidence (previously
 * `.sapMPopover` on the row tiers, added on a guess rather than an observed
 * dialog) is left out; `.sapMPopover` still participates in overlay-open
 * detection via `OVERLAY_SELECTOR` above, unaffected.
 */
export async function findCandidateRows(
  page: Page,
  baseline: ReadonlySet<string> = NO_BASELINE,
  limit = 8,
): Promise<RowCandidate[]> {
  const exclude = excludeBaseline(baseline);
  const gridRow = '[role="row"]:not(:has([role="columnheader"]))';

  const rowSelectors = [
    /*
     * `.sapMLIB` is SAPUI5's `ListItemBase` root class, and it is the one
     * marker every selectable row carries regardless of which list-based
     * control rendered it -- confirmed across three live value-help dialogs on
     * the same form: a `TableSelectDialog` whose rows are
     * `<tr class="sapMLIB ... sapMListTblRow">`, and two `SelectDialog`s whose
     * rows are `<li class="sapMLIB ... sapMSLI">`. Different tags, different
     * controls, same class. It also excludes the header row for free: that is
     * `sapMListTblRow sapMListTblHeader`, with no `sapMLIB`.
     *
     * This sits first because it is more precise than the tag-shape tiers
     * below, which have to guess at `tr` vs `li` vs `[role="row"]` and cannot
     * tell a data row from a header without extra qualification. Those remain
     * as fallbacks for lists this class does not reach (web components, plain
     * ARIA grids, hand-built markup).
     */
    `.sapMDialog${exclude} .sapMLIB:not(.sapMListNoData)`,
    `[role="dialog"]${exclude} .sapMLIB:not(.sapMListNoData)`,
    `.sapMSelectList${exclude} li:not(.sapMSelectListItemDisabled)`,
    `.sapMComboBoxBasePicker${exclude} li:not(.sapMSelectListItemDisabled)`,
    `.sapMMultiComboBoxPicker${exclude} li`,
    `.sapMSelectDialog${exclude} li`,
    `.sapMValueHelpDialog${exclude} tbody tr`,
    `.sapMDialog${exclude} tbody tr`,
    `.sapMDialog${exclude} li`,
    `[role="listbox"]${exclude} [role="option"]`,
    `[role="dialog"]${exclude} tbody tr`,
    `dialog[open]${exclude} tbody tr`,
    `dialog[open]${exclude} li`,
    `.sapMValueHelpDialog${exclude} ${gridRow}`,
    `.sapMDialog${exclude} ${gridRow}`,
    `[role="dialog"]${exclude} ${gridRow}`,
    `dialog[open]${exclude} ${gridRow}`,
    `[role="grid"]${exclude} ${gridRow}`,
    `[role="treegrid"]${exclude} ${gridRow}`,
    // `role="tree"` (sap.m.Tree, sap.ui.table.TreeTable in tree mode) marks
    // its rows `role="treeitem"` rather than `role="row"` — same ARIA family,
    // same justification as the grid tier above.
    `[role="tree"]${exclude} [role="treeitem"]`,
    // @ui5/webcomponents' `ui5-table` renders rows as this custom element,
    // slotted into the light DOM rather than a shadow-hidden `<tr>`.
    `.sapMDialog${exclude} ui5-table-row`,
    `[role="dialog"]${exclude} ui5-table-row`,
    `dialog[open]${exclude} ui5-table-row`,
  ];

  const candidates: RowCandidate[] = [];
  // The same physical row can satisfy more than one tier (e.g. a `<tr>` that
  // also carries `role="row"`) -- keyed on visible text so it is only offered
  // once, which matters once the caller is limited to a couple of retries.
  const seenText = new Set<string>();

  for (const sel of rowSelectors) {
    const options = page.locator(sel);
    const count = await options.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 5) && candidates.length < limit; i++) {
      const opt = options.nth(i);
      if (!(await opt.isVisible().catch(() => false))) continue;
      const rawText = ((await opt.innerText().catch(() => '')) || '').trim();
      /*
       * Skip header rows, empty placeholders, and the row a list shows while
       * its data is still loading — selecting that would store a placeholder
       * as though it were a real value. "More" is a growing-list trigger, not
       * a row.
       *
       * The empty-state pattern is matched as a phrase, not an exact string,
       * because `sap.m.List` renders its "nothing here" message *as a list
       * item* (it carries `sapMLIB` like any real row) and the wording varies
       * per control -- a single live run produced "No data", "No results
       * found." and "No items selected." from three different value helps,
       * of which only the first matched the old exact-match list. The other
       * two were therefore clicked as though they were data. Anchored at the
       * start and requiring a following word so a genuine row such as
       * "Nomura Holdings" cannot be swallowed by it. `.sapMListNoData` on the
       * selectors above catches the framework-rendered case structurally;
       * this catches the rest.
       */
      if (
        !rawText ||
        /^(select|none|more)$/i.test(rawText) ||
        /^no\s+(data|results?|items?|entries|records?|matches|matching)\b/i.test(rawText) ||
        /^loading\s*\.*$/i.test(rawText)
      ) {
        continue;
      }

      const text = rawText.split('\n')[0]?.trim() ?? rawText;
      if (seenText.has(text)) continue;
      seenText.add(text);

      const source = sel.replace(/:not\(#[^)]*\)/g, '');
      candidates.push({ locator: opt, text, source });
      log.debug(`  [overlay] findCandidateRows: candidate via "${source}" — "${text}"`);
    }
    if (candidates.length >= limit) break;
  }

  if (!candidates.length) {
    log.debug('  [overlay] findCandidateRows: no candidate row found in any tier');
  }
  return candidates;
}

/**
 * Clicks the first candidate row and returns its text, unverified.
 *
 * Used by plain dropdowns and multi-selects, whose picker closes itself the
 * instant an option is clicked -- there is nothing further to observe, so a
 * click that did not throw is already the whole signal. Value-help dialogs
 * need more than this; see `selectVerifiedOption` below.
 */
export async function selectFirstOption(
  page: Page,
  timeoutMs: number,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<string | null> {
  const [first] = await findCandidateRows(page, baseline, 1);
  if (!first) return null;

  await first.locator.click({ timeout: timeoutMs }).catch(() => undefined);
  await page.waitForTimeout(200);
  log.debug(`  [overlay] selectFirstOption: clicked "${first.text}"`);
  return first.text;
}

/** Why `selectVerifiedOption` considers a click to have actually taken effect. */
export type SelectionOutcome = 'overlay_closed' | 'row_selected' | 'field_changed';

/**
 * Clicks candidate rows in order until one produces an *observed* effect,
 * rather than trusting that a click which did not throw means a value-help
 * selection was registered.
 *
 * A row existing and being clickable proves nothing about whether the
 * application's own selection logic fired -- a stray unrelated row inside the
 * same dialog is exactly as clickable as the real result row. So each
 * candidate is clicked, an explicit confirm is attempted (a no-op where the
 * dialog has no OK/Select button), and only then is the outcome checked:
 * the overlay closed (the common "tap a row, dialog closes" pattern with no
 * OK button, exactly the shape seen in the "Sales Area" dialog that motivated
 * this), the row gained `aria-selected="true"` (dialogs that require a
 * separate OK press), or the caller's own `fieldChanged` check reports the
 * underlying field's value moved. Any one of the three is enough evidence;
 * requiring all of them would fail dialogs that only ever satisfy one. A
 * candidate that produces none of them is left alone -- not assumed selected
 * -- and the next candidate is tried instead.
 */
/*
 * Capped at two candidates, not the full set `findCandidateRows` can return.
 * For a documentation crawler a wrong selection is worse than a failed one:
 * once two independent, plausible rows have both been clicked without
 * producing any observed effect, the far more likely explanation is that this
 * dialog's confirmation shape doesn't match any of the three signals below --
 * not that the third or fourth row is the "real" one. Escalating further
 * would mean leaving a trail of clicks across a live system's real data with
 * no way to know which of them stuck.
 */
const MAX_SELECTION_ATTEMPTS = 2;

/**
 * Waits for a picker's rows to actually be there, polling until at least one
 * candidate exists or the budget runs out.
 *
 * Rows being present *is* the load signal. The absence of a spinner is not:
 * a live DOM dump shows `sap.m.TableSelectDialog` keeping its
 * `.sapMBusyIndicator` in the DOM with no hiding style of its own while the
 * table underneath already holds its loaded rows, so waiting for that element
 * to disappear can wait forever on a dialog that finished loading. Waiting
 * for data instead is both the stronger signal and immune to however a given
 * control chooses to hide its indicator.
 *
 * Returns as soon as rows appear -- this is not a fixed delay, so a picker
 * that is already loaded costs one poll.
 */
export async function waitForCandidateRows(
  page: Page,
  timeoutMs: number,
  baseline: ReadonlySet<string> = NO_BASELINE,
  limit = MAX_SELECTION_ATTEMPTS,
): Promise<RowCandidate[]> {
  const deadline = Date.now() + timeoutMs;
  let rows = await findCandidateRows(page, baseline, limit);

  while (rows.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(200);
    rows = await findCandidateRows(page, baseline, limit);
  }
  return rows;
}

export async function selectVerifiedOption(
  page: Page,
  timeoutMs: number,
  baseline: ReadonlySet<string> = NO_BASELINE,
  fieldChanged?: () => Promise<boolean>,
): Promise<{ text: string; outcome: SelectionOutcome } | null> {
  // Rows first, spinner never: see `waitForCandidateRows`.
  const candidates = await waitForCandidateRows(page, timeoutMs, baseline, MAX_SELECTION_ATTEMPTS);

  /*
   * Every attempt records what actually happened, because "no candidate row
   * produced a verified selection" on its own names no cause and leaves the
   * next step to guesswork -- which is exactly how several rounds of fixes
   * got made against hypotheses instead of evidence. On failure this is
   * emitted at `warn`, not `debug`: the default log threshold is `info`, so
   * anything logged at `debug` is discarded before it reaches a human or the
   * web UI's job log, and a diagnostic nobody can read is not a diagnostic.
   */
  const attempts: string[] = [];

  if (!candidates.length) {
    log.warn(
      `  value help: no candidate row matched any selector tier — overlay contents: ${await describeOverlayContents(page, baseline)}`,
    );
    return null;
  }

  for (const candidate of candidates) {
    const clicked = await candidate.locator
      .click({ timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
    if (!clicked) {
      attempts.push(`"${candidate.text}" (via ${candidate.source}): click failed`);
      continue;
    }

    /*
     * `confirmOverlay` only ever targets a button whose own text is "OK" or
     * "Select" -- the standard SAP Fiori confirm labels for exactly this
     * dialog shape -- and is a no-op when neither is present. It never clicks
     * "whatever the first button is"; a Cancel-labelled button does not match
     * either string, so this cannot be the blind first-button click it might
     * look like at a glance.
     */
    await confirmOverlay(page, baseline);

    // Poll rather than checking once: an async update (a re-render, a
    // debounced field binding) that hasn't landed yet must not be mistaken
    // for a click with no effect, which would trigger an unnecessary -- and
    // on a live system, risky -- click on a second, possibly wrong row. 3s
    // comfortably covers realistic debounce/re-render delays without
    // charging the full per-control budget to every candidate.
    const deadline = Date.now() + Math.min(timeoutMs, 3000);
    let lastAria: string | null = null;
    while (Date.now() < deadline) {
      const overlayClosed = !(await isOverlayOpen(page, baseline));
      if (overlayClosed) {
        log.debug(`  [overlay] selectVerifiedOption: "${candidate.text}" verified via overlay_closed`);
        return { text: candidate.text, outcome: 'overlay_closed' };
      }

      lastAria = await candidate.locator.getAttribute('aria-selected').catch(() => null);
      if (lastAria === 'true') {
        log.debug(`  [overlay] selectVerifiedOption: "${candidate.text}" verified via row_selected`);
        return { text: candidate.text, outcome: 'row_selected' };
      }

      if (fieldChanged && (await fieldChanged().catch(() => false))) {
        log.debug(`  [overlay] selectVerifiedOption: "${candidate.text}" verified via field_changed`);
        return { text: candidate.text, outcome: 'field_changed' };
      }

      await page.waitForTimeout(150);
    }

    attempts.push(
      `"${candidate.text}" (via ${candidate.source}): clicked, but overlay stayed open, ` +
        `aria-selected=${lastAria ?? 'absent'}, field unchanged`,
    );
  }

  log.warn(
    `  value help: ${candidates.length} candidate row(s) clicked, none produced a verified selection — ` +
      attempts.join('; '),
  );

  log.debug('  [overlay] selectVerifiedOption: no candidate produced a verified selection');
  return null;
}

/**
 * Confirms a non-baseline dialog that requires an explicit OK/Select to apply
 * a choice.
 *
 * Only used after a row has actually been selected in a value-help dialog.
 */
export async function confirmOverlay(
  page: Page,
  baseline: ReadonlySet<string> = NO_BASELINE,
): Promise<void> {
  const exclude = excludeBaseline(baseline);
  const ok = page
    .locator(
      `.sapMDialog${exclude} button:has-text("OK"), .sapMDialog${exclude} button:has-text("Select"), ` +
        `[role="dialog"]${exclude} button:has-text("OK"), [role="dialog"]${exclude} button:has-text("Select"), ` +
        `dialog[open]${exclude} button:has-text("OK"), dialog[open]${exclude} button:has-text("Select")`,
    )
    .first();
  if (await ok.isVisible().catch(() => false)) {
    await ok.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
}
