import { randomUUID } from 'node:crypto';
import type { Page } from '../automation/types.js';
import type {
  ControlDescriptor,
  Evidence,
  PageState,
  VersionId,
} from '../types.js';
import {
  isDismissLabel,
  interactionTypeFor,
  semanticObjectOf,
  urlPath,
  withTimeout,
} from './explorer-helpers.js';
import type { AppConfig } from '../config/schema.js';
import { waitForStability } from '../browser/stability.js';
import { discoverControls } from '../discovery/classifier.js';
import { hasMeaningfulLabel, type LabelResolver } from '../discovery/labels.js';
import {
  handlerFor,
  type HandlerContext,
  type HandlerResult,
} from '../interaction/handlers.js';
import { mayClick } from '../interaction/safety.js';
import {
  closeOverlay,
  overlayCount,
  selectorsInsideOverlay,
  NO_BASELINE,
} from '../interaction/overlay.js';
import {
  acknowledgeIfMessage,
  acknowledgeMessageDialogs,
  chooseOption,
  detectChooser,
  hideConsumedChooser,
  waitForChooser,
  type DialogInfo,
} from '../interaction/dialogs.js';
import { waitForAppReady } from '../browser/readiness.js';
import { EvidenceStore } from '../evidence/store.js';
import { TestDataProvider } from '../testdata/provider.js';
import {
  fingerprintState,
  structuralSignature,
  structureFullyReplaced,
} from './fingerprint.js';
import { BudgetTracker } from './budget.js';
import { log } from '../util/logger.js';
import type { ManualGate } from './manualGate.js';
import { runManualStep } from '../interaction/manual.js';
import type { RemoteControl } from '../server/remoteControl.js';

/**
 * Recursive page explorer.
 *
 * Each page is an independent unit: it is photographed on entry, every relevant
 * control is processed in document order, newly revealed controls are appended
 * to the queue as they appear, and the page is photographed again once complete.
 * Branches are then explored depth-first with explicit backtracking.
 */
export class Explorer {
  private readonly visited = new Set<string>();
  /**
   * Each page's application-authored structure as it stood when the page was
   * entered, keyed by pageId. Held here rather than on `PageState` because it
   * is identity-checking state, not evidence — the trace on disk stays a
   * record of what was documented.
   */
  private readonly structureByPage = new Map<string, string[]>();
  /**
   * Branch points already taken on the path currently being explored.
   *
   * A chooser is consumed by `exploreChooser`, which clicks one option and
   * explores what it leads to. The dialog it came from is not always torn down
   * afterwards: a real capture of this workflow shows the chooser still
   * carrying `visibility: visible` in the static area while the form behind it
   * is fully rendered and being documented. Its options are ordinary
   * framework list items, so discovery finds them like any other control and
   * the provisional-button path clicks them -- which re-answers the branch
   * question, re-instantiates the view, and invalidates every control already
   * queued for this page. That surfaced as a long run of "element no longer in
   * the page" for fields that were on screen throughout.
   *
   * Held as a stack because branches nest, and populated purely from what
   * `detectChooser` actually reported at run time.
   */
  private readonly consumedBranchPoints: {
    title: string;
    options: Set<string>;
  }[] = [];
  private readonly budget: BudgetTracker;
  /**
   * Full-page segments captured so far for the page currently being
   * processed, one batch per section — reset at the start of each page in
   * `explore()`, appended to by `captureSectionFullPage`, and turned into
   * that page's single "Full Page" evidence record once all its sections
   * are done. See `EvidenceStore.captureFullPageSection`.
   */
  private fullPageSegments: string[] = [];
  private branchesExplored = 0;
  private controlsDiscovered = 0;
  private controlsProcessed = 0;
  /** Entry URL, used to get back to a chooser after exploring a branch. */
  private rootUrl = '';
  /**
   * The Fiori semantic object this run is anchored to (e.g.
   * "RequestCustomerExtended", from a route like
   * "#RequestCustomerExtended-requestCustomer"). A navigation that lands on a
   * different one has left the application being documented — most commonly
   * the shell's own Home icon, present on every single page, or an app-finder
   * tile — and must never be followed, or exploration wanders through every
   * application launchable from the shell rather than the one being
   * documented.
   */
  private rootScope = '';

  constructor(
    private readonly page: Page,
    private readonly app: AppConfig,
    private readonly version: VersionId,
    private readonly store: EvidenceStore,
    private readonly resolver: LabelResolver,
    private readonly testData: TestDataProvider,
    /**
     * Present only in Manual data-entry mode. When set, `processOne` pauses
     * before each control and waits for operator confirmation instead of
     * running its automatic handler — see `runManualStep` in interaction/manual.ts.
     */
    private readonly manualGate?: ManualGate,
    /** Also Manual-mode only — streams the active control's page live and forwards input. */
    private readonly remoteControl?: RemoteControl,
  ) {
    this.budget = new BudgetTracker(app.budgets);
  }

  get stats() {
    return {
      branchesExplored: this.branchesExplored,
      controlsDiscovered: this.controlsDiscovered,
      controlsProcessed: this.controlsProcessed,
      pagesVisited: this.budget.pages,
      budgetStops: this.budget.budgetStops,
    };
  }

  /** Entry point: explores from the current page as the root. */
  async run(): Promise<void> {
    this.rootUrl = this.page.url();
    this.rootScope = semanticObjectOf(this.rootUrl);
    await this.settle();
    await this.explore(['Root'], undefined, 0);
  }

  /**
   * Brings the application to a workable state.
   *
   * Waits for the initial render to finish, then clears any message dialogs
   * that would otherwise block every interaction beneath them.
   */
  private async settle(): Promise<void> {
    const result = await waitForAppReady(
      this.page,
      this.app.budgets.appReadyTimeoutMs,
    );
    log.debug(
      `  ready after ${(result.elapsedMs / 1000).toFixed(0)}s ` +
        `(interactive=${result.interactive}, dialogs=${result.visibleDialogs})`,
    );
    await acknowledgeMessageDialogs(this.page, {
      stabilityMs: this.app.budgets.stabilityTimeoutMs,
    });
  }

  /**
   * Reloads the application entry point and returns it to a workable state.
   *
   * Navigating to a URL that differs from the current one only by its hash is a
   * same-document navigation, which would leave a single-page application
   * exactly where it is. Clearing the page first forces a genuine reload, so
   * the entry dialog is presented again.
   */
  private async returnToRoot(): Promise<void> {
    log.step('Returning to the application entry point…');

    await this.page
      .goto('about:blank', { timeout: 30_000 })
      .catch(() => undefined);

    await this.page
      .goto(this.rootUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      .catch(() => undefined);

    await this.settle();
  }

  /**
   * Explores one page to completion, then descends into its branches.
   */
  private async explore(
    workflowPath: string[],
    parentPageId: string | undefined,
    depth: number,
  ): Promise<void> {
    if (this.budget.runExhausted()) return;

    await waitForStability(this.page, this.app.budgets.stabilityTimeoutMs);

    /*
     * `run()` only dismisses message dialogs once, in `settle()`, before the
     * very first `explore()` call. A validation message that renders after
     * that check (a live capture showed "Both Account Group and Sales Org is
     * mandatory" fully on screen at first-page-capture, never dismissed for
     * the rest of the run) is invisible to `waitForChooser` below — it
     * explicitly ignores message dialogs — so it sat blocking every control
     * on the page for the whole run (0 controls discovered) with nothing
     * ever trying its OK button again. Re-running the same dismissal here
     * catches it before it can do that.
     */
    await acknowledgeMessageDialogs(this.page, {
      stabilityMs: this.app.budgets.stabilityTimeoutMs,
    });

    /*
     * A chooser dialog asks which variant of the workflow to enter, so it is a
     * branch point rather than page content: each option is explored in full,
     * and the page behind the dialog is never documented on its own.
     *
     * A short, fixed window rather than a budget field: this is purely
     * covering the render gap between the message dialog's dismissal above
     * and a chooser's subsequent appearance, not a general "how long to wait
     * for an interaction" concern — most pages have no chooser at all, and
     * would otherwise pay this wait in full on every single visit if it were
     * tied to a budget sized for real interactions.
     */
    const chooser = await waitForChooser(this.page, 6000);
    if (chooser && !this.budget.depthExhausted(depth)) {
      await this.exploreChooser(chooser, workflowPath, parentPageId, depth);
      return;
    }

    const fingerprint = await fingerprintState(this.page);
    if (this.visited.has(fingerprint)) {
      log.debug(`already explored state ${fingerprint}; backtracking`);
      return;
    }
    this.visited.add(fingerprint);
    this.budget.countPage();

    const pageState: PageState = {
      pageId: randomUUID().slice(0, 8),
      fingerprint,
      url: this.page.url(),
      title: (await this.page.title().catch(() => '')) || workflowPath.at(-1) || 'Page',
      workflowPath: [...workflowPath],
      completed: false,
    };
    if (parentPageId) pageState.parentPageId = parentPageId;
    this.store.registerPage(pageState);
    this.structureByPage.set(
      pageState.pageId,
      await structuralSignature(this.page),
    );

    log.step(`Page: ${workflowPath.join(' → ')}  [${pageState.title}]`);
    this.manualGate?.reset();

    // Rule: every page is photographed on entry, before any dummy data.
    await this.store.capture({
      page: this.page,
      pageState,
      label: pageState.title,
      canonicalLabel: pageState.title,
      interactionType: 'initialFullPage',
    });

    this.fullPageSegments = [];
    const pageOk = await this.processTabs(pageState, workflowPath, depth);

    /*
     * "Full Page" is only meaningful when this really is still the page being
     * documented. `pageOk` is false exactly when some control navigated away
     * and the explorer's own backtrack could not verify its way back -- at
     * that point the page on screen is unknown (see processOne's comment on
     * `ok`), most often because backtrack's fallback chain (history, then
     * direct URL, then reload) ran out of options and landed on the shell's
     * own launchpad rather than back inside the form.
     *
     * `pageOk` alone only proves the *last* backtrack didn't fail; independently
     * re-checking with the same `verifyOnPage` used to judge backtrack success
     * elsewhere in this file catches any other way the page in front of the
     * camera might not be the one on record, using the same fingerprint/title/
     * URL identity check throughout rather than a second, different one here.
     */
    const onPage = pageOk && (await this.verifyOnPage(pageState));
    if (onPage) {
      /*
       * Each section already captured its own full-page batch, right after
       * that section's own fields were filled (see `captureSectionFullPage`,
       * called from `processTabs`) -- those batches are cumulated here into
       * this page's one "Full Page" evidence record, in the order the
       * sections were processed, so the document shows Form Section's filled
       * state, then Copy Section's, and so on, all under one heading.
       *
       * The fallback only fires when nothing was captured per-section at all
       * (a page with no tabs whose sole section-capture failed, or one cut
       * short before its first section finished) -- a safety net, not the
       * normal path.
       */
      if (this.fullPageSegments.length === 0) {
        await acknowledgeMessageDialogs(this.page, {
          max: 3,
          stabilityMs: this.app.budgets.stabilityTimeoutMs,
        }).catch(() => []);
        await closeOverlay(this.page).catch(() => undefined);
        await this.store.capture({
          page: this.page,
          pageState,
          label: 'Full Page',
          canonicalLabel: 'Full Page',
          interactionType: 'finalFullPage',
        });
      } else {
        this.store.finalizeFullPage(pageState, this.fullPageSegments);
      }
    } else {
      log.warn(
        `Skipping "Full Page" capture for "${pageState.title}": page identity ` +
          `could not be verified after processing, so a screenshot here would ` +
          `document the wrong page instead of this one's final state.`,
      );
    }
    this.store.markPageComplete(pageState.pageId);

    if (pageOk) {
      await this.exploreBranches(pageState, workflowPath, depth);
    } else {
      log.warn(
        `Skipping branch exploration from "${pageState.title}": a mid-page ` +
          `navigation could not be verified back, so this page's remaining ` +
          `structure cannot be trusted.`,
      );
    }
  }

  /**
   * Explores every option of a chooser dialog.
   *
   * The open dialog is captured once per option, labelled with that option, and
   * attributed to the branch it leads into — which reproduces the reference
   * documents, where a workflow begins with a point such as "Organization"
   * showing the category dialog, followed by that branch's own fields.
   *
   * After each branch the application is reloaded to bring the chooser back,
   * because the dialog is presented at entry and cannot be reopened in place.
   */
  private async exploreChooser(
    chooser: DialogInfo,
    workflowPath: string[],
    parentPageId: string | undefined,
    depth: number,
  ): Promise<void> {
    const optionLabels = chooser.options.map((o) => o.label);
    log.step(
      `Branch point "${chooser.title || 'choice'}": ${optionLabels.join(' / ')}`,
    );

    this.consumedBranchPoints.push({
      title: (chooser.title || '').trim().toLowerCase(),
      options: new Set(optionLabels.map((l) => l.trim().toLowerCase())),
    });
    try {
      await this.exploreChooserOptions(
        chooser,
        optionLabels,
        workflowPath,
        parentPageId,
        depth,
      );
    } finally {
      this.consumedBranchPoints.pop();
    }
  }

  /** Takes each option of an already-registered branch point in turn. */
  private async exploreChooserOptions(
    chooser: DialogInfo,
    optionLabels: string[],
    workflowPath: string[],
    parentPageId: string | undefined,
    depth: number,
  ): Promise<void> {
    for (const [i, label] of optionLabels.entries()) {
      if (this.budget.runExhausted()) return;

      // Later options need the dialog restored before they can be taken.
      if (i > 0) {
        let again: DialogInfo | null = null;
        for (let attempt = 1; attempt <= 3 && !again; attempt++) {
          await this.returnToRoot();
          again = await detectChooser(this.page);
          if (!again) {
            log.debug(`  branch point not showing yet (attempt ${attempt}/3)`);
          }
        }
        if (!again) {
          log.error(
            `Could not restore the "${chooser.title || 'choice'}" branch point after ` +
              `3 attempts; "${label}" and any remaining options will not be explored.`,
          );
          return;
        }
      }

      const childPath = [...workflowPath, label];

      // Registered like any other page so the hierarchy and validation stay
      // consistent, even though its content is a single evidence item.
      const chooserPageId = randomUUID().slice(0, 8);
      const chooserPage: PageState = {
        pageId: chooserPageId,
        fingerprint: `chooser:${label}:${await fingerprintState(this.page).catch(() => '')}`,
        url: this.page.url(),
        title: chooser.title || 'Selection',
        workflowPath: childPath,
        completed: true,
      };
      if (parentPageId) chooserPage.parentPageId = parentPageId;
      this.store.registerPage(chooserPage);

      /*
       * Captured before the option is taken, so the evidence shows the choice
       * as the tester sees it, and attributed to the branch's own path so it
       * heads that branch's section of the document.
       */
      await this.store.capture({
        page: this.page,
        pageState: chooserPage,
        label,
        canonicalLabel: label,
        interactionType: 'dialogOpen',
      });

      log.step(`Taking branch: ${label}`);
      const taken = await chooseOption(
        this.page,
        label,
        this.app.budgets.controlTimeoutMs,
      );
      if (!taken) {
        log.warn(`  could not select "${label}"; skipping this branch`);
        continue;
      }

      await waitForStability(this.page, this.app.budgets.stabilityTimeoutMs);
      await waitForAppReady(this.page, this.app.budgets.appReadyTimeoutMs);
      await acknowledgeMessageDialogs(this.page, {
        stabilityMs: this.app.budgets.stabilityTimeoutMs,
      });

      /*
       * See `hideConsumedChooser`: some applications leave the chooser
       * dialog's own DOM in place after its option is taken, live for the
       * rest of the branch. Left alone, every later overlay-aware helper
       * scans it right alongside whatever a genuinely new interaction opens,
       * and a broad-enough fallback selector can click back into it -- which
       * re-answers this exact branch mid-exploration. Done once per branch,
       * after the chosen option's own selection has had a chance to land.
       */
      await hideConsumedChooser(this.page, chooser.title);

      this.branchesExplored++;
      await this.explore(childPath, chooserPageId, depth + 1);
    }
  }

  /**
   * Processes every relevant control on the current page.
   *
   * The queue is rebuilt as work proceeds so that controls revealed by an
   * earlier interaction are picked up without restarting the page. Returns
   * false when a mid-page navigation could not be verified back to this page
   * — the caller must then treat this page's remaining structure (and any
   * further interaction on it) as untrustworthy.
   */
  /**
   * Processes a page's tabs as sections of that page.
   *
   * A tab switch swaps which controls are on screen but does not leave the
   * page, so tabs are *not* child pages. Treating them as children produced
   * the `Organization → Form → Form → Form` chain: each child still showed the
   * same tab bar, so the tab that had just been clicked was discovered again
   * and followed again, and because the form now held values its fingerprint
   * differed every time, so loop detection never recognised the repeat.
   *
   * Handling them here also matches the reference documents, which present
   * "Form Section" / "Copy Section" / "Attachment Section" within a single
   * version block closed by one "Full Page".
   */
  private async processTabs(
    pageState: PageState,
    workflowPath: string[],
    depth: number,
  ): Promise<boolean> {
    const tabs = (
      await discoverControls(this.page, this.app, this.resolver)
    ).filter((c) => c.kind === 'tab' && hasMeaningfulLabel(c.label));

    // The tab currently selected is already showing; process it in place.
    const firstLabel = await this.activeTabLabel();
    let ok = await this.processControls(
      pageState,
      workflowPath,
      depth,
      firstLabel,
    );
    if (!ok) return false;
    await this.captureSectionFullPage(pageState, firstLabel);

    const done = new Set<string>(firstLabel ? [firstLabel.toLowerCase()] : []);

    for (const tab of tabs) {
      if (this.budget.runExhausted()) return ok;

      const label = tab.canonicalLabel || tab.label;
      const key = label.trim().toLowerCase();
      if (!key || done.has(key)) continue;
      done.add(key);

      const verdict = mayClick(label, this.app.safety, tab.title);
      if (!verdict.allowed) {
        log.debug(`skipping tab "${label}": ${verdict.reason}`);
        continue;
      }

      /*
       * A dropdown or picker left open by the last field of the previous tab
       * puts a modal block layer over the whole page, and the tab bar sits
       * under it -- the click is then intercepted and the tab is reported
       * unopenable even though nothing is wrong with it. Fields get this
       * treatment already inside `waitUntilEditable`; tab switches need it
       * too, since they are clicks on the same covered page.
       */
      await closeOverlay(this.page).catch(() => undefined);

      const before = await fingerprintState(this.page);

      /*
       * Re-resolved by label immediately before the click rather than reused
       * from the sweep above. Processing the previous tab takes as long as
       * that tab has controls, and a form that re-renders in the meantime
       * (selecting a value routinely redraws a whole cluster of dependent
       * fields) renumbers the view the captured selector was built from, so
       * the click lands on nothing and the tab is reported unopenable while
       * plainly on screen.
       */
      const current = await this.findTabByLabel(label);
      if (!current) {
        log.warn(`  could not open tab "${label}": no longer present`);
        continue;
      }

      const selector = current.fallbackSelector ?? current.selector;
      const clicked = await this.page
        .locator(selector)
        .first()
        .click({ timeout: this.app.budgets.controlTimeoutMs })
        .then(() => true)
        .catch(() => false);
      if (!clicked) {
        log.warn(`  could not open tab "${label}"`);
        continue;
      }

      await waitForStability(this.page, this.app.budgets.stabilityTimeoutMs);
      await acknowledgeMessageDialogs(this.page, {
        max: 3,
        stabilityMs: this.app.budgets.stabilityTimeoutMs,
      }).catch(() => []);

      if ((await fingerprintState(this.page)) === before) {
        log.debug(`  tab "${label}" showed nothing new`);
        continue;
      }

      log.step(`Tab: ${label}`);
      /*
       * The engine caused this change itself and has already confirmed it
       * happened, so the tab's own content becomes the structure this page is
       * verified against from here on. Without the refresh the page would
       * still be measured against the tab it has deliberately left.
       */
      this.structureByPage.set(
        pageState.pageId,
        await structuralSignature(this.page),
      );
      ok = await this.processControls(pageState, workflowPath, depth, label);
      if (!ok) return false;
      await this.captureSectionFullPage(pageState, label);
    }

    return true;
  }

  /**
   * Captures the page top-to-bottom right after one section's fields are
   * done, and appends the result to `fullPageSegments` for this page.
   *
   * Applies equally in Manual and Automatic mode: both run through
   * `processControls` above (Manual only gates each fill through the manual
   * queue), so this runs immediately after either mode finishes a section,
   * with no mode-specific branch needed here.
   *
   * Any dialog left open by the section just finished -- a validation
   * message, or a chooser the last field's own value-help reopened -- is
   * dismissed first. Message dialogs and choosers both get a dismissal
   * attempt here, unlike the ordinary per-control closing helpers, which
   * deliberately leave a chooser open for the explorer to answer: by this
   * point the section is done, so nothing should still be waiting on it.
   */
  private async captureSectionFullPage(
    pageState: PageState,
    tab?: string,
  ): Promise<void> {
    await acknowledgeMessageDialogs(this.page, {
      max: 3,
      stabilityMs: this.app.budgets.stabilityTimeoutMs,
    }).catch(() => []);
    await closeOverlay(this.page).catch(() => undefined);

    const segments = await this.store.captureFullPageSection(
      this.page,
      pageState,
      tab,
    );
    this.fullPageSegments.push(...segments);
  }

  /** Re-discovers a tab by its label, so a stale selector is never clicked. */
  private async findTabByLabel(
    label: string,
  ): Promise<ControlDescriptor | undefined> {
    const key = label.trim().toLowerCase();
    const controls = await discoverControls(this.page, this.app, this.resolver);
    return controls.find(
      (c) =>
        c.kind === 'tab' &&
        (c.canonicalLabel || c.label).trim().toLowerCase() === key,
    );
  }

  /** Label of the tab currently selected, when the page has a tab bar. */
  private async activeTabLabel(): Promise<string | undefined> {
    const label = await this.page
      .evaluate(() => {
        const el = document.querySelector(
          '.sapMITBSelected, [role="tab"][aria-selected="true"], [role="tab"].sapMITBSelected',
        );
        return (el as HTMLElement | null)?.innerText?.trim() ?? '';
      })
      .catch(() => '');

    const cleaned = label.replace(/\s+/g, ' ').trim();
    return cleaned || undefined;
  }

  private async processControls(
    pageState: PageState,
    workflowPath: string[],
    depth: number,
    tab?: string,
  ): Promise<boolean> {
    const done = new Set<string>();
    /*
     * How many times each control has been attempted. A control skipped for a
     * transient reason is released back into the queue, and this bounds how
     * often that can happen so a permanently-hidden field cannot be retried
     * once per sweep for the whole run.
     */
    const attempts = new Map<string, number>();
    const MAX_ATTEMPTS = 2;
    const counter = { processed: 0, retried: 0 };
    let integrityOk = true;

    /**
     * Processes every not-yet-handled control currently on screen.
     *
     * Passed to handlers as `exploreRevealed` so that a dialog's own fields are
     * filled while the dialog is still open, then again as the outer sweep so
     * that controls revealed on the page itself are picked up.
     */
    const drain = async (
      nesting: number,
      overlayBase: ReadonlySet<string> = NO_BASELINE,
    ): Promise<boolean> => {
      /*
       * At page level, clear any validation message the previous control
       * raised: it sits above the form and would block every control beneath
       * it. Nested drains are skipped, because there the open dialog is the
       * one currently being documented.
       */
      if (nesting === 0) {
        await acknowledgeMessageDialogs(this.page, {
          max: 3,
          stabilityMs: this.app.budgets.stabilityTimeoutMs,
        }).catch(() => []);

        /*
         * Every existing "did we leave the page" check -- `navigatedAway`,
         * `semanticObjectOf` scope comparison, `urlPath` -- reads the URL, on
         * the assumption that leaving means the address bar changes. A real
         * run disproved that: a session lost mid-crawl let the shell swap its
         * displayed application to the launchpad's own Home page while the
         * hash in `page.url()` stayed exactly the SPA route it already was --
         * the swap is the shell's own client-side view change, not a browser
         * navigation, so nothing URL-based ever sees it. The next sweep then
         * dutifully discovered and documented the Home page's own controls
         * (the user menu, "Personalize Home Page", "Add Group", "Reset") as
         * if they belonged to the form.
         *
         * `verifyOnPage`'s title+urlPath fallback is exactly what catches
         * this: the URL matches, but the title does not ("Home" instead of
         * the form's own title), so identity is checked before every sweep,
         * not only once at page entry.
         */
        if (!(await this.verifyOnPage(pageState))) {
          log.warn(
            `  page identity lost before this sweep (now showing something ` +
              `other than "${pageState.title}"); attempting to recover before ` +
              `documenting whatever is currently on screen.`,
          );
          if (!(await this.backtrack(pageState))) {
            integrityOk = false;
            return false;
          }
          log.ok(`  recovered "${pageState.title}"; resuming this page's sweep.`);
        }
      }

      const controls = await discoverControls(this.page, this.app, this.resolver);
      this.controlsDiscovered += controls.length;

      let pending = controls.filter(
        (c) => !done.has(c.dedupeKey) && this.shouldProcess(c),
      );

      /*
       * Manual mode must never even show the operator a deny-listed button
       * (Save/Submit/Delete/Post/...), not just avoid clicking it. Automatic
       * mode leaves this check inside `probeButton` (a button is still
       * "processed," just refused there), which is fine when nothing is ever
       * surfaced to a human — but manual mode publishes `pending` to the
       * operator's queue below, before `processOne` ever runs, so filtering
       * only at that later point (as this file previously did) still listed
       * "Save" as a waiting item even though it could never actually be
       * activated. Filtering here keeps it out of the queue entirely.
       */
      if (this.manualGate) {
        pending = pending.filter((c) => {
          const isButton = c.kind === 'actionButton' || c.kind === 'revealButton';
          if (!isButton) return true;
          return mayClick(c.label, this.app.safety, c.title).allowed;
        });
      }

      // A nested drain runs while a dialog is open, where only that dialog's
      // own fields are reachable -- and `overlayBase` keeps it scoped to the
      // dialog this exploration actually opened, not any leftover overlay
      // already on screen alongside it (see `overlayBaseline`).
      if (nesting > 0) {
        const inside = await selectorsInsideOverlay(
          this.page,
          pending.map((c) => c.selector),
          overlayBase,
        );
        pending = pending.filter((c) => inside.has(c.selector));
      }

      // Publishes this sweep's newly-discovered controls to the operator's
      // queue. `setQueue` upserts, so items already in progress/completed/
      // skipped from an earlier sweep keep their status.
      if (this.manualGate) {
        const queueItems = await Promise.all(
          pending.map(async (c) => {
            const options = await extractSelectionOptions(this.page, c);
            return {
              id: c.dedupeKey,
              label: c.canonicalLabel || c.label || c.id,
              kind: c.kind,
              ...(c.section ? { section: c.section } : {}),
              ...(tab ? { tab } : {}),
              ...(options ? { options } : {}),
              status: 'waiting' as const,
            };
          }),
        );
        this.manualGate.setQueue(queueItems);
      }

      if (pending.length === 0) return false;
      let didWork = false;

      for (const control of pending) {
        if (!integrityOk) return didWork;
        if (this.budget.controlsExhausted(counter.processed)) return didWork;
        if (this.budget.runExhausted()) return didWork;
        if (this.page.isClosed()) return didWork;

        // A nested drain may already have handled this control since `pending`
        // was computed.
        if (done.has(control.dedupeKey)) continue;

        /*
         * A nested drain documents one open dialog. Once that dialog has gone
         * — dismissed by something clicked inside it — the rest of the queue
         * refers to elements that no longer exist, and grinding through them
         * produces a long run of "element no longer in the page" for controls
         * nothing is wrong with. Stop instead.
         */
        if (nesting > 0 && (await overlayCount(this.page)) === 0) {
          log.debug('  the dialog being documented has closed; ending its sweep');
          return didWork;
        }

        done.add(control.dedupeKey);
        const attempt = (attempts.get(control.dedupeKey) ?? 0) + 1;
        attempts.set(control.dedupeKey, attempt);
        counter.processed++;
        this.controlsProcessed++;
        didWork = true;

        const outcome = await this.processOne(
          control,
          pageState,
          workflowPath,
          depth,
          nesting,
          drain,
          tab,
        );

        /*
         * Released back into the queue: the control was hidden or covered at
         * this moment, which a later sweep may resolve once whatever was
         * hiding it has been opened. Without this, a field behind a collapsed
         * panel is marked handled on the first pass and never revisited, even
         * though the sweeps exist precisely to catch controls that appear
         * later.
         */
        if (outcome.retryable && attempt < MAX_ATTEMPTS) {
          done.delete(control.dedupeKey);
          counter.retried++;
        }

        if (!outcome.ok) {
          integrityOk = false;
          return didWork;
        }
      }
      return didWork;
    };

    // Re-discovery sweeps catch controls revealed by earlier interactions.
    for (let sweep = 0; sweep < 6 && integrityOk; sweep++) {
      const before = counter.processed;
      const didWork = await drain(0);
      log.debug(
        `  [sweep ${sweep + 1}/6] processed ${counter.processed - before} control(s) this pass ` +
          `(${counter.processed} total, ${counter.retried} retried so far, integrityOk=${integrityOk})`,
      );
      if (!didWork) break;
    }

    return integrityOk;
  }

  /**
   * Decides whether a control is worth interacting with.
   *
   * Read-only fields, tabs and nav items are excluded here: tabs and nav items
   * are branches, handled during backtracking rather than as page content.
   */
  private shouldProcess(control: ControlDescriptor): boolean {
    if (control.kind === 'readonly' || control.kind === 'unknown') return false;
    if (control.kind === 'tab' || control.kind === 'navItem') return false;

    const isButton =
      control.kind === 'actionButton' || control.kind === 'revealButton';
    if (isButton) {
      /*
       * A button with no real wording cannot be safety-checked, and clicking it
       * blind risks navigating away from the form being documented. An
       * icon-only button (no visible label at all) can still carry its
       * meaning in `title` — a real tooltip, not a substitute label — so
       * that counts too; `mayClick` itself is what actually checks it.
       */
      if (
        !hasMeaningfulLabel(control.label) &&
        !hasMeaningfulLabel(control.title ?? '')
      ) {
        return false;
      }
      // Dialog dismissal controls close the very UI being documented, and are
      // driven by the overlay helpers rather than processed as page content.
      if (isDismissLabel(control.label)) return false;
      /*
       * A disclosure toggle that is already open has nothing left to reveal —
       * clicking it can only collapse content that is already visible. A real
       * run clicked exactly such a panel header as an ordinary button: the
       * panel closed, its 17 fields went invisible for the rest of the run
       * (each skipped as "not interactable"), and the collapse was itself
       * misrecorded as a documentation point because the DOM did change, just
       * not usefully. A toggle discovered already collapsed is unaffected and
       * still gets clicked, exactly as the "expandable sections" the
       * discovery probes describe are meant to be.
       */
      if (control.alreadyExpanded) return false;
      /*
       * Re-answering a branch point the run has already taken restarts the
       * workflow underneath the page being documented; see
       * `consumedBranchPoints`.
       */
      if (this.reEntersConsumedBranchPoint(control)) {
        log.debug(
          `skipping "${control.label}": re-enters an already-taken branch point`,
        );
        return false;
      }
    }
    return true;
  }

  /**
   * True when a control is one of the options of a branch point already taken.
   *
   * Matched on the option's own wording together with the section the control
   * reports, which for a control inside a dialog resolves to that dialog's
   * title -- so a field that merely happens to share a word with an option
   * ("Organization" as a form field, say) is not caught, only an option
   * sitting in the chooser it came from. Both halves are values `detectChooser`
   * observed at run time, so nothing here is specific to any one application.
   */
  private reEntersConsumedBranchPoint(control: ControlDescriptor): boolean {
    if (this.consumedBranchPoints.length === 0) return false;

    const label = (control.canonicalLabel || control.label || '')
      .trim()
      .toLowerCase();
    if (!label) return false;
    const section = (control.section ?? '').trim().toLowerCase();

    return this.consumedBranchPoints.some(
      (point) =>
        point.options.has(label) && (!point.title || point.title === section),
    );
  }

  /**
   * Runs one control's handler, recording evidence or an exception.
   *
   * `ok` is false only when the control navigated to a new page and the
   * explorer could not verify its way back — the signal that stops the caller
   * from touching anything else on what is now an unknown page. `retryable`
   * marks a control that was skipped for a reason a later sweep may clear.
   */
  private async processOne(
    control: ControlDescriptor,
    pageState: PageState,
    workflowPath: string[],
    depth: number,
    nesting: number,
    drain: (nesting: number, overlayBase?: ReadonlySet<string>) => Promise<boolean>,
    tab?: string,
  ): Promise<{ ok: boolean; retryable?: boolean }> {
    const handler = handlerFor(control.kind);
    if (!handler) return { ok: true };

    log.debug(
      `  [control] "${control.canonicalLabel || control.label || control.id}" ` +
        `kind=${control.kind} isPoint=${control.isPoint} selector=${control.selector}`,
    );

    const interactionType = interactionTypeFor(control);
    let captured = false;
    let record: Evidence | undefined;

    /**
     * Buttons are classified provisionally, because whether one reveals new UI
     * can only be known by clicking it. `probeButton` calls `capture` only when
     * it did reveal something, which is exactly when the button is a point.
     */
    const isProvisionalButton =
      control.kind === 'actionButton' || control.kind === 'revealButton';
    const mayCapture = control.isPoint || isProvisionalButton;

    /*
     * Separately from capture gating above: does this control's handler ever
     * call `exploreRevealed` -- i.e. does it recurse into a dialog's own
     * fields the way `probeButton` does? `handleValueHelp` does exactly this
     * (see handlers.ts) to document a lookup dialog's filter fields, variant
     * selector and any sub-popovers as thoroughly as the page that opened it.
     * Confirmed on a live capture (new-version landscape, "Commission Payee"
     * / "Vendor" value help): the dialog's own "Filters" toggle reveals a
     * nested popover with an unexpanded panel, and probing that nested
     * content -- entirely legitimate, bounded recursion, already capped by
     * `nesting < 2` and each nested control's own budget -- was still
     * running when the flat 30-second wrapper below fired and killed the
     * whole tree mid-interaction, frozen with that popover still open. The
     * exemption from that wrapper was written for buttons specifically
     * ("legitimately recurse into a revealed dialog and may run far
     * longer"), but the actual reason a handler needs it is recursion, not
     * being a button -- `valueHelp` shares that shape and was simply missed.
     * Keyed by control kind, exactly like every other classification in this
     * codebase, not by any field name or label.
     */
    const mayRecurse = isProvisionalButton || control.kind === 'valueHelp';

    const ctx: HandlerContext = {
      page: this.page,
      budgets: this.app.budgets,
      safety: this.app.safety,
      testData: this.testData,
      capture: async () => {
        // Only controls that yield a documentation point contribute evidence.
        if (!mayCapture) return;

        /*
         * A validation message raised by this interaction would sit on top of
         * the control being documented. Clearing it first keeps the evidence
         * showing the workflow rather than an incidental popup; anything that
         * is not a message (a picker, a lookup) is left alone, since that is
         * the evidence itself.
         *
         * Uses acknowledgeIfMessage's own tighter default rather than
         * stabilityTimeoutMs: this is confirming a dialog closed, not waiting
         * for the page to become navigable again, and re-raised JP-locale
         * format-validation messages (phone/fax/address fields rejecting the
         * generic 'TEST01' fallback) could otherwise burn the full
         * page-navigation stability budget on each of up to 3 dismiss
         * attempts, exceeding the flat 30s handler wrapper below.
         */
        await acknowledgeIfMessage(this.page).catch(() => false);

        captured = true;
        record = await this.store.capture({
          page: this.page,
          pageState,
          label: control.label || control.canonicalLabel,
          canonicalLabel: control.canonicalLabel || control.label,
          interactionType,
          ...(tab ? { tab } : {}),
          ...(control.section ? { section: control.section } : {}),
          ...(control.containerType ? { containerType: control.containerType } : {}),
          ...(control.containerLabel ? { containerLabel: control.containerLabel } : {}),
          controlKind: control.kind,
        });
      },
      // Bounded so that a dialog opening a dialog cannot recurse indefinitely.
      ...(nesting < 2
        ? {
            exploreRevealed: async (overlayBase: ReadonlySet<string>) =>
              void (await drain(nesting + 1, overlayBase)),
          }
        : {}),
    };

    try {
      /*
       * Leaf handlers get an outer timeout as a safety net. Button handlers do
       * not: they legitimately recurse into a revealed dialog and may run far
       * longer, and a rejected wrapper would not stop the underlying work —
       * leaving two explorations running concurrently over the same page.
       * Their individual actions are already bounded by their own per-call timeouts.
       *
       * Manual mode replaces the handler entirely with `runManualStep`, which
       * legitimately waits on a human and must never be subject to either the
       * flat timeout (a real person takes longer than any control-interaction
       * budget) or the automatic fill logic itself — discovery, safety and
       * capture are unchanged, only the fill step is swapped out. A button
       * this run's safety policy would refuse to click automatically is never
       * handed to the operator either: `probeButton` normally performs this
       * check itself, but manual mode bypasses `probeButton` entirely, so the
       * same check is applied here before the control ever reaches the queue.
       */
      let result: HandlerResult;
      if (this.manualGate) {
        if (isProvisionalButton) {
          const verdict = mayClick(control.label, this.app.safety, control.title);
          if (!verdict.allowed) {
            log.debug(`skipping unsafe button (manual mode): ${verdict.reason}`);
            this.store.recordSafetySkip(control, verdict.reason);
            return { ok: true };
          }
        }
        result = await runManualStep(control, ctx, this.manualGate, this.remoteControl);
      } else if (mayRecurse) {
        result = await handler(control, ctx);
      } else {
        result = await withTimeout(
          handler(control, ctx),
          /*
           * +20s, not +10s: a handler's own click/fill/waitForStability calls
           * are each already bounded by controlTimeoutMs/stabilityTimeoutMs,
           * but capture() can additionally run acknowledgeMessageDialogs's
           * up-to-3-iteration dismiss loop (see DIALOG_DISMISS_SETTLE_MS in
           * interaction/dialogs.ts) after them. That loop is now capped
           * cheaply per iteration, but this margin exists as a safety net for
           * that combined worst case rather than the flat 10s pad -- a lone
           * budget-sized wait was previously enough to blow a 30s wrapper on
           * its own.
           */
          this.app.budgets.controlTimeoutMs + 20_000,
          `handler for "${control.label}"`,
        );
      }

      /*
       * A button's true kind is only known after it has been tried, so the
       * evidence recorded mid-handler is corrected here. This affects the
       * internal trace only; the generated document shows just the label.
       */
      if (record && result.reclassifiedAs) {
        record.controlKind = result.reclassifiedAs;
        if (result.reclassifiedAs === 'revealButton') {
          record.interactionType = 'dialogOpen';
        }
      }

      if (result.safetySkipped) {
        this.store.recordSafetySkip(
          control,
          result.note ?? 'blocked by safety policy',
        );
      }

      if (captured) {
        // Promoted from debug to ok: this is the one line that tells a
        // normal user something was actually documented, so it must survive
        // the default log level — previously it was filtered out entirely
        // while every skip/warning below stayed visible, making a normal
        // run's log read as an unbroken stream of negative-looking lines.
        const name = control.canonicalLabel || control.label;
        log.ok(result.note ? `captured "${name}" — ${result.note}` : `captured "${name}"`);
      } else if (result.note) {
        log.debug(`  ${control.canonicalLabel || control.label}: ${result.note}`);
      }

      /*
       * A genuine navigation is explored as a real child page — but only when
       * it actually lands inside the application being documented. A link
       * that leaves it (the shell's Home icon, an app-finder tile) is
       * captured as a point already, by `ctx.capture()` above; recursing into
       * it would mean documenting a different application entirely, and
       * following its own "Home" link straight back leads to exactly the kind
       * of Home-tile-Home-tile loop this check exists to prevent.
       */
      if (result.navigatedAway) {
        const childLabel = control.canonicalLabel || control.label;
        const destination = semanticObjectOf(this.page.url());
        const inScope = !this.rootScope || destination === this.rootScope;

        if (!inScope) {
          // Expected boundary behaviour, not a failure — the link was
          // captured (see ctx.capture() above), it just leads outside the
          // application being documented, so it is not worth alarming a
          // normal user with `warn`'s amber styling over.
          log.info(`  "${childLabel}" leads outside this application; captured, not explored further.`);
        } else if (this.budget.depthExhausted(depth)) {
          log.info(`  "${childLabel}" is past the exploration depth limit; captured, not explored further.`);
        } else {
          log.step(`Following navigation: ${childLabel}`);
          const childPath = [...workflowPath, childLabel];
          this.branchesExplored++;
          await this.explore(childPath, pageState.pageId, depth + 1);
        }

        const restored = await this.backtrack(pageState);
        if (!restored) return { ok: false };
      }

      return { ok: true, ...(result.retryable ? { retryable: true } : {}) };
    } catch (err) {
      await this.store.recordException({
        page: this.page,
        pageState,
        control,
        action: `interact:${control.kind}`,
        error: err,
      });
      // Leave no overlay open, or the next control cannot be reached. An
      // exception here means this control failed, not that page identity was
      // lost, so processing continues.
      await closeOverlay(this.page).catch(() => undefined);
      await acknowledgeMessageDialogs(this.page, { max: 3 }).catch(() => []);
      await waitForStability(this.page, this.app.budgets.stabilityTimeoutMs).catch(
        () => undefined,
      );
      return { ok: true };
    }
  }

  /**
   * Explores tabs and navigation branches depth-first.
   *
   * After each branch the explorer returns to this page's state before taking
   * the next one, so sibling branches all start from the same place.
   */
  private async exploreBranches(
    pageState: PageState,
    workflowPath: string[],
    depth: number,
  ): Promise<void> {
    if (this.budget.depthExhausted(depth)) return;
    if (this.budget.runExhausted()) return;

    /*
     * Tabs are deliberately excluded: they are sections of this page and were
     * already covered by `processTabs`. Following them here as well is what
     * produced the repeated `Form → Form → Form` chain.
     */
    const controls = await discoverControls(this.page, this.app, this.resolver);
    const branches = controls.filter((c) => c.kind === 'navItem');

    for (const branch of branches) {
      if (this.budget.runExhausted()) return;

      const label = branch.canonicalLabel || branch.label;
      if (!label.trim()) continue;

      const verdict = mayClick(label, this.app.safety, branch.title);
      if (!verdict.allowed) {
        log.debug(`skipping branch "${label}": ${verdict.reason}`);
        continue;
      }

      const beforeFingerprint = await fingerprintState(this.page);

      const clicked = await this.page
        .locator(branch.selector)
        .first()
        .click({ timeout: this.app.budgets.controlTimeoutMs })
        .then(() => true)
        .catch(() => false);

      if (!clicked) continue;

      await waitForStability(this.page, this.app.budgets.stabilityTimeoutMs);
      const afterFingerprint = await fingerprintState(this.page);

      if (afterFingerprint === beforeFingerprint) {
        // The branch led nowhere new; nothing to explore or restore.
        continue;
      }

      if (this.visited.has(afterFingerprint)) {
        if (!(await this.backtrack(pageState))) return;
        continue;
      }

      this.branchesExplored++;
      await this.explore([...workflowPath, label], pageState.pageId, depth + 1);

      /*
       * A failed, unverified return means the page now on screen is unknown.
       * Continuing to the next sibling would interact with whatever that page
       * happens to be, so exploration of this page's remaining branches stops.
       */
      if (!(await this.backtrack(pageState))) return;
    }
  }

  /**
   * Returns to a previously explored page and verifies the return succeeded.
   *
   * Escalates through progressively stronger recovery strategies — browser
   * history, then direct URL navigation, then a hard reload — verifying after
   * each one via fingerprint, title and URL rather than assuming the first
   * attempt worked. No screenshot is taken on success: the parent page's
   * evidence is already complete, and the reference documents show no such
   * capture.
   *
   * Returns false when no strategy restores the target page. The caller must
   * not interact with any control after a false result: doing so would act on
   * whatever page happened to be left on screen.
   */
  private async backtrack(target: PageState): Promise<boolean> {
    if (this.page.isClosed()) {
      log.error(`Cannot recover to "${target.title}": the browser page has closed.`);
      return false;
    }

    await closeOverlay(this.page).catch(() => undefined);

    if (await this.verifyOnPage(target)) return true;

    const strategies: { name: string; run: () => Promise<void> }[] = [
      {
        name: 'history back',
        run: async () => {
          await this.page.goBack({ timeout: 10_000 }).catch(() => undefined);
        },
      },
      {
        name: 'history back (again)',
        run: async () => {
          await this.page.goBack({ timeout: 10_000 }).catch(() => undefined);
        },
      },
      {
        name: 'direct navigation',
        run: async () => {
          await this.page
            .goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            .catch(() => undefined);
        },
      },
      {
        name: 'reload then navigate',
        run: async () => {
          await this.page.goto('about:blank', { timeout: 15_000 }).catch(() => undefined);
          await this.page
            .goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            .catch(() => undefined);
        },
      },
      {
        /*
         * Last resort: the specific target page could not be reached by any
         * direct means, so go back to the application's entry link instead.
         * This will not verify against `target` (it is a different page) and
         * `backtrack` still correctly reports failure — but it leaves the
         * browser on a known, in-scope page rather than wherever a runaway
         * navigation left it, so whatever runs next starts from solid ground
         * instead of compounding the problem.
         */
        name: 'reload application entry point',
        run: async () => {
          await this.returnToRoot();
        },
      },
    ];

    for (const strategy of strategies) {
      log.debug(`  recovering to parent page via ${strategy.name}…`);
      await strategy.run();
      /*
       * A strategy that actually reloads (all but plain history navigation)
       * puts the browser through the exact same slow bootstrap the initial
       * load went through -- shell paints, component loads, route resolves,
       * data fetches -- which `stabilityTimeoutMs` was never sized for; that
       * budget covers settling after a single interaction, not a cold start.
       * Checking `verifyOnPage` right after only that short wait means a
       * genuinely successful reload is judged before it has rendered
       * anything, which reads as failure and moves on to the next strategy
       * -- or exhausts all of them -- while the real recovery was still only
       * seconds away. `waitForAppReady` is the same readiness gate the
       * initial load itself waits on, and already returns as soon as content
       * looks stable rather than always spending its full budget, so a
       * strategy that did not actually reload anything (plain history
       * navigation) is not slowed down by this.
       */
      await waitForAppReady(this.page, this.app.budgets.appReadyTimeoutMs).catch(
        () => undefined,
      );
      await waitForStability(this.page, this.app.budgets.stabilityTimeoutMs).catch(
        () => undefined,
      );
      await acknowledgeMessageDialogs(this.page, {
        max: 2,
        stabilityMs: this.app.budgets.stabilityTimeoutMs,
      }).catch(() => []);

      if (await this.verifyOnPage(target)) {
        log.debug(`  confirmed back on "${target.title}" via ${strategy.name}`);
        return true;
      }
    }

    log.error(
      `Could not verify return to "${target.title}" [${target.workflowPath.join(' → ')}] ` +
        `after trying every recovery strategy. Remaining branches at this level will not ` +
        `be explored, to avoid interacting with the wrong page.`,
    );
    return false;
  }

  /**
   * Confirms the browser is actually showing the expected page.
   *
   * Fingerprint is the primary signal (it reflects the rendered control tree,
   * not just the URL); title and URL are checked as independent corroboration,
   * since a stale fingerprint cache or a coincidentally similar control set
   * should not be trusted alone.
   */
  private async verifyOnPage(target: PageState): Promise<boolean> {
    const [fingerprint, title, url] = await Promise.all([
      fingerprintState(this.page).catch(() => ''),
      this.page.title().catch(() => ''),
      Promise.resolve(this.page.url()).catch(() => ''),
    ]);

    if (fingerprint && fingerprint === target.fingerprint) return true;

    // Fingerprint can legitimately shift with dynamic content (timestamps,
    // counters). Title + same URL path is accepted as corroborating evidence.
    const sameTitle = !!target.title && title === target.title;
    const sameUrlPath = urlPath(url) === urlPath(target.url);
    if (!sameTitle || !sameUrlPath) return false;

    /*
     * Both halves above can be constant for an entire run: a shell that keeps
     * one document title for every application it hosts, and a single-page
     * application that keeps one URL across every state, leave this fallback
     * with nothing to compare and it accepts whatever is on screen. That is
     * how a form replaced by the shell's own home page went on being treated
     * as the form, and the home page's controls were documented as its
     * fields.
     *
     * The structure the page was entered with is the remaining evidence: if
     * none of it is rendered any more, this is not that page, whatever the
     * title and address still say. See `structureFullyReplaced` for why the
     * test is all-or-nothing rather than proportional.
     */
    const recorded = this.structureByPage.get(target.pageId);
    if (!recorded) return true;
    const current = await structuralSignature(this.page);
    return !structureFullyReplaced(recorded, current);
  }
}

/**
 * Extracts available options from a select, multiSelect, or valueHelp control
 * so the manual UI can display them as clickable buttons instead of requiring
 * pixel-perfect clicks in the video.
 *
 * Returns undefined if extraction fails or isn't applicable.
 */
async function extractSelectionOptions(
  page: Page,
  control: ControlDescriptor,
): Promise<{ value: string; label: string }[] | undefined> {
  if (
    control.kind !== 'select' &&
    control.kind !== 'multiSelect' &&
    control.kind !== 'valueHelp'
  ) {
    return undefined;
  }

  try {
    return await page
      .locator(control.selector)
      .first()
      .evaluate((el: Element) => {
        const target = el as HTMLElement;

        // For UI5 ComboBox / MultiComboBox / Input with value help:
        // Look for list items that would be clickable
        const items = target.querySelectorAll(
          '[role="option"], [role="menuitem"], .sapMSelectListItem, .sapMLIBase, .sapMListItemBase',
        );
        if (items.length > 0) {
          return Array.from(items)
            .slice(0, 100) // Cap at 100 options
            .map((item) => ({
              value: (item as any).innerText?.trim() || (item as HTMLElement).textContent?.trim() || '',
              label: (item as any).innerText?.trim() || (item as HTMLElement).textContent?.trim() || '',
            }))
            .filter((opt) => opt.label);
        }

        // For native select elements
        if (target instanceof HTMLSelectElement) {
          return Array.from(target.options)
            .slice(0, 100)
            .map((opt) => ({
              value: opt.value,
              label: opt.textContent?.trim() || opt.value,
            }));
        }

        return undefined;
      })
      .catch(() => undefined);
  } catch {
    return undefined;
  }
}

