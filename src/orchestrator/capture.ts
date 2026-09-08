import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { loadLexicon, loadTestData, OUTPUT_DIR, requireVersion } from '../config/load.js';
import { openSession } from '../browser/manager.js';
import { buildResolver } from '../discovery/labels.js';
import { TestDataProvider } from '../testdata/provider.js';
import { EvidenceStore } from '../evidence/store.js';
import { Explorer } from '../state/explorer.js';
import type { ManualGate } from '../state/manualGate.js';
import { RemoteControl } from '../server/remoteControl.js';
import type { ExecutionReport, RunTrace, VersionId } from '../types.js';
import { log } from '../util/logger.js';

export interface CaptureOptions {
  headless?: boolean;
  /** Overrides the generated run id, so a run can be re-targeted. */
  runId?: string;
  /**
   * Present only for a Manual data-entry mode run — bridges the explorer's
   * per-control pauses to whatever is confirming them (the web job's HTTP
   * endpoint). Absent for Automatic mode, which behaves exactly as before.
   */
  manualGate?: ManualGate;
  /**
   * Fired once the page exists, with the `RemoteControl` bound to it — the
   * caller (the web job) needs this reference to serve the live view and
   * forward input, but only `captureVersion` is in a position to construct
   * it (it owns the page's lifecycle). Only invoked when `manualGate` is set.
   */
  onRemoteControlReady?: (remote: RemoteControl) => void;
}

/**
 * Captures one application version end to end.
 *
 * Each version is explored independently: no knowledge of the other version's
 * pages, fields or ordering influences the traversal, because the two versions
 * genuinely differ in the systems this tool documents.
 */
export async function captureVersion(
  app: AppConfig,
  version: VersionId,
  opts: CaptureOptions = {},
): Promise<{ trace: RunTrace; runDir: string }> {
  const versionCfg = requireVersion(app, version);
  const runId = opts.runId ?? `${app.name}-${version}-${stamp()}`;
  const runDir = path.join(OUTPUT_DIR, 'runs', runId);
  await mkdir(runDir, { recursive: true });

  const [lexicon, testDataCfg] = await Promise.all([loadLexicon(), loadTestData()]);
  const resolver = buildResolver(lexicon, app);
  const testData = new TestDataProvider(testDataCfg, app);

  const store = new EvidenceStore(runId, version, runDir);
  await store.init();

  const startedAt = new Date();
  log.info(`Capture starting: ${app.name} (${version})`);

  /*
   * The operator never looks at a native window in either mode: Automatic
   * runs unattended, and Manual mode's operator watches/drives the page
   * through the streamed live view (see interaction/manual.ts,
   * server/remoteControl.ts) rather than a visible browser window. Headless
   * Chromium screencasts identically to headed, so there is no reason to
   * open a real window for either mode.
   */
  const session = await openSession(app, version, {
    ...(opts.headless === undefined ? {} : { headless: opts.headless }),
  });

  let stats = {
    branchesExplored: 0,
    controlsDiscovered: 0,
    controlsProcessed: 0,
    pagesVisited: 0,
    budgetStops: [] as string[],
  };

  let remoteControl: RemoteControl | undefined;
  if (opts.manualGate) {
    remoteControl = new RemoteControl(session.page);
    opts.onRemoteControlReady?.(remoteControl);
  }

  try {
    const explorer = new Explorer(
      session.page,
      app,
      version,
      store,
      resolver,
      testData,
      opts.manualGate,
      remoteControl,
    );
    await explorer.run();
    stats = explorer.stats;
  } finally {
    await session.close();
  }

  const finishedAt = new Date();
  const counts = store.counts;

  const report: ExecutionReport = {
    runId,
    version,
    appName: app.name,
    url: versionCfg.url,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    pagesVisited: stats.pagesVisited,
    controlsDiscovered: stats.controlsDiscovered,
    controlsProcessed: stats.controlsProcessed,
    pointsCaptured: counts.points,
    screenshotsCaptured: counts.screenshots,
    branchesExplored: stats.branchesExplored,
    exceptions: store.getExceptions(),
    safetySkipped: store.getSafetySkipped(),
    budgetStops: stats.budgetStops,
  };

  const trace: RunTrace = {
    runId,
    appName: app.name,
    version,
    url: versionCfg.url,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    pages: store.getPages(),
    evidence: store.getEvidence(),
    report,
  };

  await store.writeTrace(trace);
  await store.writeReport(report);

  log.ok(
    `Capture complete: ${counts.points} points, ${counts.screenshots} screenshots, ` +
      `${stats.pagesVisited} pages, ${report.exceptions.length} exceptions`,
  );
  if (stats.budgetStops.length) {
    log.warn(`Stopped early: ${stats.budgetStops.join('; ')}`);
  }
  log.info(`Trace: ${path.join(runDir, 'trace.json')}`);

  return { trace, runDir };
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}
