import { readdir, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { OUTPUT_DIR } from '../config/load.js';
import { buildDocument } from '../document/builder.js';
import type { AiSummaryResult } from '../doc-intelligence/index.js';
import type { Evidence, RunTrace, VersionId } from '../types.js';
import { log } from '../util/logger.js';

/**
 * Assembly stage.
 *
 * Reads traces produced by earlier capture runs and emits the Word document.
 * Because it never drives a browser, formatting can be corrected and the
 * document regenerated without repeating a slow capture run.
 */
export async function assembleDocument(
  app: AppConfig,
  opts: {
    runIds?: Partial<Record<VersionId, string>>;
    outputPath?: string;
    /** Included in the document only when the caller passes it — see the job's inclusion toggles. */
    generalSummary?: AiSummaryResult;
    aiSummary?: AiSummaryResult;
  } = {},
): Promise<string> {
  const traces: Partial<Record<VersionId, { trace: RunTrace; runDir: string }>> = {};

  for (const version of ['old', 'new'] as VersionId[]) {
    const runId = opts.runIds?.[version] ?? (await latestRunId(app.name, version));
    if (!runId) {
      log.debug(`no capture run found for ${version}; skipping`);
      continue;
    }
    const runDir = path.join(OUTPUT_DIR, 'runs', runId);
    const traceFile = path.join(runDir, 'trace.json');
    if (!existsSync(traceFile)) {
      // Attempt to synthesise a minimal trace from available screenshots so
      // that documents can still be assembled when the capture's trace.json
      // is not present (for example after a manual copy of screenshots).
      const synth = await synthesizeTraceFromScreenshots(runDir, runId, version, app.name);
      if (synth) {
        traces[version] = { trace: synth, runDir };
        log.info(`Synthesised trace from screenshots for ${version} run ${runId} (${synth.evidence.length} evidence)`);
        continue;
      }
      log.warn(`trace missing for run ${runId}; skipping`);
      continue;
    }
    const trace = JSON.parse(await readFile(traceFile, 'utf8')) as RunTrace;
    traces[version] = { trace, runDir };
    log.info(
      `Using ${version} run ${runId} (${trace.evidence.length} evidence records)`,
    );
  }

  if (!traces.old && !traces.new) {
    throw new Error(
      `No capture runs found for "${app.name}".\n` +
        `Run:  npm run capture -- --app ${app.name} --version new`,
    );
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath =
    opts.outputPath ?? path.join(OUTPUT_DIR, `${safeName(app.title)}.docx`);

  await buildDocument({
    title: app.title,
    traces,
    outputPath,
    generalSummary: opts.generalSummary,
    aiSummary: opts.aiSummary,
  });
  log.ok(`Document written: ${outputPath}`);
  return outputPath;
}

/**
 * When a run directory lacks a `trace.json`, builds a minimal `RunTrace` from
 * the files in `screenshots/`. Filenames are parsed to produce labels where
 * possible. This keeps assembly usable for a run whose trace was lost while
 * its screenshots survived, at the cost of losing page/section grouping —
 * every screenshot is placed on one synthetic page.
 */
async function synthesizeTraceFromScreenshots(
  runDir: string,
  runId: string,
  version: VersionId,
  appName: string,
): Promise<RunTrace | null> {
  const shotsDir = path.join(runDir, 'screenshots');
  if (!existsSync(shotsDir)) return null;

  let entries: string[];
  try {
    entries = await readdir(shotsDir);
  } catch {
    return null;
  }

  const pngs = entries.filter((f) => f.toLowerCase().endsWith('.png')).sort();
  if (pngs.length === 0) return null;

  const evidence: Evidence[] = pngs.map((fn, i) => {
    // Strip leading sequence numbers and optional "exc-" prefix.
    const base = fn.replace(/^(?:exc-)?\d+-?/i, '').replace(/\.png$/i, '');
    const label = base.replace(/[-_]+/g, ' ').trim() || fn;
    const status = fn.startsWith('exc-') ? 'exception' : 'ok';
    return {
      seq: i + 1,
      runId,
      version,
      workflowPath: ['Root'],
      pageId: 'synthesised',
      pageTitle: appName,
      label,
      canonicalLabel: label,
      interactionType: i === pngs.length - 1 ? 'finalFullPage' : 'fill',
      screenshotPath: path.join('screenshots', fn),
      status,
    };
  });

  const now = new Date().toISOString();
  const trace: RunTrace = {
    runId,
    appName,
    version,
    url: '',
    startedAt: now,
    finishedAt: now,
    pages: [],
    evidence,
    report: {
      runId,
      version,
      appName,
      url: '',
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      pagesVisited: 0,
      controlsDiscovered: 0,
      controlsProcessed: 0,
      pointsCaptured: evidence.length,
      screenshotsCaptured: evidence.length,
      branchesExplored: 0,
      exceptions: [],
      safetySkipped: [],
      budgetStops: [],
    },
  };

  return trace;
}

/** Finds the most recent run directory for an app/version pair. */
async function latestRunId(
  appName: string,
  version: VersionId,
): Promise<string | null> {
  const runsDir = path.join(OUTPUT_DIR, 'runs');
  if (!existsSync(runsDir)) return null;

  const prefix = `${appName}-${version}-`;
  const entries = await readdir(runsDir, { withFileTypes: true });
  const matching = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => e.name)
    .sort();

  return matching.at(-1) ?? null;
}

function safeName(title: string): string {
  return title.replace(/[<>:"/\\|?*]/g, '-').trim() || 'document';
}
