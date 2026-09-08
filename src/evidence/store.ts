import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '../automation/types.js';
import type {
  ControlDescriptor,
  Evidence,
  ExceptionRecord,
  InteractionType,
  PageState,
  SafetySkipRecord,
  VersionId,
} from '../types.js';
import { captureScrollSegments } from './scroll-capture.js';
import { log } from '../util/logger.js';

/**
 * Evidence store.
 *
 * Owns screenshot capture, sequencing and the on-disk trace. Sequence numbers
 * are global to a run and define document order, so the assembly stage never has
 * to reconstruct chronology.
 */
export class EvidenceStore {
  private seq = 0;
  private readonly evidence: Evidence[] = [];
  private readonly exceptions: ExceptionRecord[] = [];
  private readonly safetySkips: SafetySkipRecord[] = [];
  private readonly pages: PageState[] = [];
  private shotCount = 0;

  constructor(
    private readonly runId: string,
    private readonly version: VersionId,
    private readonly runDir: string,
  ) {}

  get screenshotDir(): string {
    return path.join(this.runDir, 'screenshots');
  }

  get counts() {
    return {
      evidence: this.evidence.length,
      exceptions: this.exceptions.length,
      pages: this.pages.length,
      screenshots: this.shotCount,
      points: this.evidence.filter(
        (e) =>
          e.interactionType !== 'initialFullPage' &&
          e.interactionType !== 'finalFullPage',
      ).length,
    };
  }

  async init(): Promise<void> {
    await mkdir(this.screenshotDir, { recursive: true });
  }

  registerPage(page: PageState): void {
    this.pages.push(page);
  }

  markPageComplete(pageId: string): void {
    const p = this.pages.find((x) => x.pageId === pageId);
    if (p) p.completed = true;
  }

  /**
   * Captures a screenshot and records it as evidence.
   *
   * Every shot here is a plain viewport capture; a "Full Page" point is built
   * separately, from consecutive scroll segments (see evidence/scroll-capture.ts)
   * rather than a single tall image, because an open dropdown or dialog is
   * positioned relative to the viewport and a full-page capture would render
   * it detached from its field.
   */
  async capture(args: {
    page: Page;
    pageState: PageState;
    label: string;
    canonicalLabel: string;
    interactionType: InteractionType;
    tab?: string;
    section?: string;
    containerType?: ControlDescriptor['containerType'];
    containerLabel?: string;
    controlKind?: ControlDescriptor['kind'];
  }): Promise<Evidence> {
    const seq = ++this.seq;
    const isFullPage =
      args.interactionType === 'initialFullPage' ||
      args.interactionType === 'finalFullPage';

    const baseName = `${String(seq).padStart(4, '0')}-${slug(
      args.canonicalLabel || args.interactionType,
    )}`;

    let fileName = `${baseName}.png`;
    let extraFiles: string[] = [];

    try {
      if (isFullPage) {
        /*
         * A whole-page capture is taken as consecutive screenfuls rather than
         * one tall image, matching the reference documents and staying legible
         * at the document's fixed embed width.
         */
        const segments = await captureScrollSegments(args.page, {
          outputDir: this.screenshotDir,
          baseName,
        });
        if (segments.length > 0) {
          fileName = segments[0]!;
          extraFiles = segments.slice(1);
          this.shotCount += segments.length;
        }
      } else {
        await screenshotWithRetry(args.page, path.join(this.screenshotDir, fileName));
        this.shotCount++;
      }
    } catch (err) {
      /*
       * A screenshot failure here means this whole point silently loses its
       * evidence: `assembleDocument` drops any point whose file doesn't
       * exist on disk (see its "missing screenshot, skipping" path), so a
       * transient CDP hiccup on one point quietly deletes it from the final
       * document rather than merely logging a warning about it, which is
       * why `screenshotWithRetry` gets one retry before this is reached at
       * all — confirmed against a real capture where four of ten points
       * were lost this way to `Page.captureScreenshot` timeouts.
       */
      log.warn(`screenshot failed for "${args.label}" (retried once): ${errMsg(err)}`);
    }

    const record: Evidence = {
      seq,
      runId: this.runId,
      version: this.version,
      workflowPath: [...args.pageState.workflowPath],
      pageId: args.pageState.pageId,
      pageTitle: args.pageState.title,
      label: args.label,
      canonicalLabel: args.canonicalLabel,
      interactionType: args.interactionType,
      screenshotPath: path.join('screenshots', fileName),
      status: 'ok',
    };
    if (extraFiles.length > 0) {
      record.additionalScreenshots = extraFiles.map((f) =>
        path.join('screenshots', f),
      );
    }
    if (args.tab) record.tab = args.tab;
    if (args.section) record.section = args.section;
    if (args.containerType) record.containerType = args.containerType;
    if (args.containerLabel) record.containerLabel = args.containerLabel;
    if (args.controlKind) record.controlKind = args.controlKind;

    this.evidence.push(record);
    return record;
  }

  /**
   * Captures the page as a batch of top-to-bottom scroll segments and
   * returns their evidence-relative paths, without creating an Evidence
   * record of its own.
   *
   * Building block for `finalizeFullPage`: a page's "Full Page" evidence is
   * assembled from one call to this per section (Form Section, Copy Section,
   * ...), each still showing that section's own filled data, rather than a
   * single shot taken after the whole page is done. Capturing immediately
   * after each section — instead of once at the very end — is what actually
   * fixes the defect this replaced: a live run showed a chooser dialog the
   * next section's own interactions had reopened still on screen by the time
   * a single closing shot got taken, silently documenting that dialog again
   * in place of the filled form.
   */
  async captureFullPageSection(
    page: Page,
    pageState: PageState,
    tab?: string,
  ): Promise<string[]> {
    const seq = ++this.seq;
    const baseName = `${String(seq).padStart(4, '0')}-full-page${tab ? `-${slug(tab)}` : ''}`;

    let segments: string[] = [];
    try {
      segments = await captureScrollSegments(page, {
        outputDir: this.screenshotDir,
        baseName,
      });
      this.shotCount += segments.length;
    } catch (err) {
      log.warn(
        `full-page section capture failed for "${pageState.title}"` +
          `${tab ? ` (${tab})` : ''}: ${errMsg(err)}`,
      );
    }

    return segments.map((f) => path.join('screenshots', f));
  }

  /**
   * Turns previously captured full-page segments into this page's one "Full
   * Page" evidence record, in document order. Returns null and records
   * nothing when there is nothing to record.
   */
  finalizeFullPage(pageState: PageState, segments: string[]): Evidence | null {
    if (segments.length === 0) return null;

    const seq = ++this.seq;
    const record: Evidence = {
      seq,
      runId: this.runId,
      version: this.version,
      workflowPath: [...pageState.workflowPath],
      pageId: pageState.pageId,
      pageTitle: pageState.title,
      label: 'Full Page',
      canonicalLabel: 'Full Page',
      interactionType: 'finalFullPage',
      screenshotPath: segments[0]!,
      status: 'ok',
    };
    if (segments.length > 1) record.additionalScreenshots = segments.slice(1);

    this.evidence.push(record);
    return record;
  }

  /**
   * Records a control that could not be automated.
   *
   * Captures the current screen so a human can see what blocked it. Exceptions
   * never appear in the generated document — they belong to the internal report.
   */
  async recordException(args: {
    page: Page;
    pageState: PageState;
    control: ControlDescriptor;
    action: string;
    error: unknown;
  }): Promise<void> {
    const seq = ++this.seq;
    const fileName = `exc-${String(seq).padStart(4, '0')}-${slug(
      args.control.canonicalLabel || args.control.id,
    )}.png`;
    const abs = path.join(this.screenshotDir, fileName);

    let shot: string | undefined;
    try {
      await args.page.screenshot({ path: abs, animations: 'disabled' });
      shot = path.join('screenshots', fileName);
      this.shotCount++;
    } catch {
      /* the page may be gone; the record still matters */
    }

    const record: ExceptionRecord = {
      seq,
      pageId: args.pageState.pageId,
      workflowPath: [...args.pageState.workflowPath],
      label: args.control.canonicalLabel || args.control.label,
      controlKind: args.control.kind,
      action: args.action,
      message: errMsg(args.error),
      at: new Date().toISOString(),
    };
    if (shot) record.screenshotPath = shot;

    this.exceptions.push(record);
    log.warn(`  exception on "${record.label}" (${args.action}): ${record.message}`);
  }

  /**
   * Records a button the safety policy refused to click.
   *
   * A deny match is a deliberate, expected outcome — not a failure — so it
   * is tracked separately from `exceptions` rather than folded into them.
   */
  recordSafetySkip(control: ControlDescriptor, reason: string): void {
    const seq = ++this.seq;
    /*
     * An icon-only button resolves no visible label at all — its `title`
     * is the only identifying text it has, and is exactly what the deny
     * match itself was made against (see `ExtraDenyCheck`), so it is the
     * right fallback rather than leaving this record unhelpfully blank.
     */
    const label = control.canonicalLabel || control.label || control.title || control.id;
    this.safetySkips.push({
      seq,
      label,
      controlKind: control.kind,
      reason,
      at: new Date().toISOString(),
    });
    log.debug(`  safety-skipped "${label}": ${reason}`);
  }

  getEvidence(): Evidence[] {
    return [...this.evidence];
  }

  getExceptions(): ExceptionRecord[] {
    return [...this.exceptions];
  }

  getSafetySkipped(): SafetySkipRecord[] {
    return [...this.safetySkips];
  }

  getPages(): PageState[] {
    return [...this.pages];
  }

  /** Writes the trace, the contract consumed by the assembly stage. */
  async writeTrace(trace: unknown): Promise<string> {
    const file = path.join(this.runDir, 'trace.json');
    await writeFile(file, JSON.stringify(trace, null, 2), 'utf8');
    return file;
  }

  async writeReport(report: unknown): Promise<string> {
    const file = path.join(this.runDir, 'report.json');
    await writeFile(file, JSON.stringify(report, null, 2), 'utf8');
    return file;
  }
}

/**
 * Takes a viewport screenshot, retrying once after a short wait on failure.
 *
 * `Page.captureScreenshot` (the underlying CDP call) occasionally times out
 * on a page that is mid-render — an animation still settling, a dialog still
 * transitioning in — even though the exact same shot succeeds a moment
 * later. Without a retry that single transient failure loses the point
 * outright: `capture()`'s caller records `Evidence` regardless, pointing at a
 * file that was never written, and `assembleDocument` silently drops any
 * point whose screenshot file doesn't exist rather than erroring — so one
 * flaky CDP call turns into a point permanently missing from the final
 * document with only a log line to explain why.
 */
async function screenshotWithRetry(page: Page, filePath: string): Promise<void> {
  try {
    await page.screenshot({ path: filePath, fullPage: false, animations: 'disabled' });
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: filePath, fullPage: false, animations: 'disabled' });
  }
}

/** Filesystem-safe slug for screenshot names. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'shot'
  );
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
