import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_DIR, PROJECT_ROOT, storageStatePath } from '../config/load.js';
import { captureVersion } from '../orchestrator/capture.js';
import { assembleDocument } from '../orchestrator/assemble.js';
import { captureLogin, probeNeedsSignIn, SessionError } from '../browser/manager.js';
import type { AppConfig } from '../config/schema.js';
import type { VersionId } from '../types.js';
import { addLogSink, log } from '../util/logger.js';
import { InMemoryManualGate, type ManualQueueItem } from '../state/manualGate.js';
import {
  generateAiDocumentationPoints,
  generateDocumentationPoints,
  type AiSummaryResult,
} from '../doc-intelligence/index.js';
import { RemoteControl } from './remoteControl.js';
import {
  buildAdHocConfig,
  configuredVersions,
  originSlug,
  type AdHocInput,
} from './adhoc.js';

/**
 * Background job execution for the web front end.
 *
 * A job documents whichever versions were supplied: one URL produces a
 * single-version document, two produce the paired document.
 *
 * Sign-in happens first, for every site that needs it, before any capture
 * begins. Sessions are saved per origin and reused, so a host is only ever
 * signed in to once.
 */

export type JobStatus = 'queued' | 'awaiting-auth' | 'running' | 'done' | 'error';

export interface JobLogLine {
  level: string;
  message: string;
  at: number;
}

/** The sign-in currently waiting on the operator. */
export interface AuthStage {
  version: VersionId;
  host: string;
  /** Position in the sign-in queue, for progress display. */
  index: number;
  total: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  title: string;
  versions: VersionId[];
  dataEntryMode: 'automatic' | 'manual';
  /** Original input retained so the document can be rebuilt (e.g. with AI Summary). */
  input?: AdHocInput;
  log: JobLogLine[];
  error?: string;
  /** Set while a live view is open waiting for the operator to sign in. */
  authStage?: AuthStage;
  /**
   * Manual data-entry mode only: every control discovered so far on the
   * current page, with its status, and which one (if any) is currently
   * waiting on the operator. Mirrors `InMemoryManualGate`'s state — see
   * `manualGates` below.
   */
  manualQueue: ManualQueueItem[];
  activeManualId?: string;
  /** Versions that could not be captured because sign-in did not complete. */
  needsLoginFor?: VersionId[];
  documentPath?: string;
  documentName?: string;
  summary?: {
    version: VersionId;
    points: number;
    pages: number;
    screenshots: number;
    exceptions: number;
  }[];
  /** Capture run id per version, kept for the AI Summary feature (jobs.ts) — the document itself no longer needs these once written. */
  runIds?: Partial<Record<VersionId, string>>;
  /** Set only once summary generation has actually been requested; absent means it was never asked for. */
  aiSummaryStatus?: 'running' | 'done' | 'error';
  aiSummary?: AiSummaryResult;
  aiSummaryError?: string;
  /**
   * The deterministic pipeline's own output, generated alongside `aiSummary`
   * so the UI can show both side by side ("General Summary" / "AI Summary").
   * Independent of the AI path: it is still produced when the LLM call fails,
   * and carries its own status so the client can tell "still working" apart
   * from "failed" instead of waiting on a result that will never arrive.
   */
  generalSummaryStatus?: 'running' | 'done' | 'error';
  generalSummary?: AiSummaryResult;
  generalSummaryError?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, Job>();

/** One entry per running Manual-mode job; removed once the job finishes. */
const manualGates = new Map<string, InMemoryManualGate>();
/** One entry per running Manual-mode job's live view — see remoteControl.ts. */
const remoteControls = new Map<string, RemoteControl>();
/** One entry per running login flow (both job-driven and standalone) live view. */
const loginRemoteControls = new Map<string, RemoteControl>();

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

/** Used by the screencast (SSE) and input-forwarding endpoints in app.ts. */
export function getRemoteControl(jobId: string): RemoteControl | undefined {
  return remoteControls.get(jobId);
}

/** Used by login-related endpoints in app.ts (both job-driven and standalone logins). */
export function getLoginRemoteControl(jobId: string): RemoteControl | undefined {
  return loginRemoteControls.get(jobId);
}

/**
 * Called by the web server's manual-confirm endpoint when the operator clicks
 * Submit/Skip. Returns false when there is no such job, no such control, or
 * the control was not actually waiting on a confirmation (e.g. a stale click
 * after the job already moved on).
 */
export function resolveManualStep(
  jobId: string,
  controlId: string,
  action: 'submit' | 'skip',
): boolean {
  const gate = manualGates.get(jobId);
  if (!gate) return false;
  return gate.resolve(controlId, action);
}

/** Reports whether this user already has a saved session for a URL. */
export function hasSessionFor(url: string, userId?: string): boolean {
  const app = buildAdHocConfig({ newUrl: url, userId }, 'probe');
  return existsSync(storageStatePath(app, 'new'));
}

/** Creates a job and starts it; returns immediately with the job id. */
export function startJob(input: AdHocInput): Job {
  const id = randomUUID().slice(0, 8);
  const app = buildAdHocConfig(input, id);
  const versions = configuredVersions(app);

  const job: Job = {
    id,
    status: 'queued',
    title: app.title,
    versions,
    dataEntryMode: app.dataEntryMode,
    input,
    manualQueue: [],
    log: [],
    startedAt: Date.now(),
  };
  jobs.set(id, job);

  if (versions.length === 0) {
    job.status = 'error';
    job.error = 'Provide at least one URL.';
    job.finishedAt = Date.now();
    return job;
  }

  void runJob(job, input);
  return job;
}

/**
 * Signs in to every site that needs it, before any capture starts.
 *
 * Sessions are stored per origin, so two versions hosted on the same origin
 * only require one sign-in. Each sign-in streams a live view to the web UI
 * (via RemoteControl) and resolves once the operator has authenticated.
 */
async function ensureSessions(job: Job, app: AppConfig): Promise<void> {
  // One entry per origin still lacking a saved session.
  const pending = new Map<string, { version: VersionId; host: string }>();

  for (const version of job.versions) {
    const cfg = app.versions[version];
    if (!cfg) continue;
    if (existsSync(storageStatePath(app, version))) {
      log.info(`${version}: using saved session.`);
      continue;
    }
    const slug = originSlug(cfg.url);
    if (pending.has(slug)) {
      log.info(`${version}: shares a sign-in with another version.`);
      continue;
    }
    pending.set(slug, { version, host: safeHost(cfg.url) });
  }

  if (pending.size === 0) return;

  /*
   * Check headlessly which of these sites actually present a sign-in screen, so
   * that an application needing no authentication never opens a window.
   */
  const needAuth: { version: VersionId; host: string }[] = [];
  for (const entry of pending.values()) {
    log.info(`Checking whether ${entry.host} requires sign-in…`);
    if (await probeNeedsSignIn(app, entry.version)) {
      needAuth.push(entry);
    } else {
      log.info(`${entry.host} needs no sign-in.`);
    }
  }

  if (needAuth.length === 0) return;

  const total = needAuth.length;
  let index = 0;

  for (const { version, host } of needAuth) {
    index++;
    job.status = 'awaiting-auth';
    job.authStage = { version, host, index, total };

    log.info(
      `Sign-in ${index} of ${total}: sign in to ${host} in the live view to continue — ` +
        `open it in its own tab at /live/jobs/${job.id}`,
    );

    await captureLogin(app, version, {
      onRemoteControlReady: (remote) => {
        loginRemoteControls.set(job.id, remote);
      },
    });
    loginRemoteControls.delete(job.id);
    log.ok(`Signed in to ${host}; session saved for future runs.`);
  }

  job.authStage = undefined;
  job.status = 'running';
}

/**
 * Captures one version, re-authenticating once if the saved session turns out
 * to have expired.
 */
async function captureWithRetry(
  job: Job,
  app: AppConfig,
  version: VersionId,
  manualGate?: InMemoryManualGate,
): Promise<Awaited<ReturnType<typeof captureVersion>>> {
  // Headless in both modes — Manual mode's operator watches through the
  // streamed live view (registered below), never a native window.
  const opts = {
    headless: true,
    ...(manualGate ? { manualGate } : {}),
    ...(manualGate
      ? {
          onRemoteControlReady: (remote: RemoteControl) => {
            remoteControls.set(job.id, remote);
          },
        }
      : {}),
  };
  try {
    return await captureVersion(app, version, opts);
  } catch (err) {
    if (!(err instanceof SessionError)) throw err;

    const cfg = app.versions[version];
    const host = cfg ? safeHost(cfg.url) : version;
    log.warn(
      `${version}: session expired — reopening sign-in for ${host}. ` +
        `Sign in in the live view, or open it in its own tab at /live/jobs/${job.id}`,
    );

    const previousStatus = job.status;
    job.status = 'awaiting-auth';
    job.authStage = { version, host, index: 1, total: 1 };

    await captureLogin(app, version, {
      onRemoteControlReady: (remote) => {
        loginRemoteControls.set(job.id, remote);
      },
    });
    loginRemoteControls.delete(job.id);

    job.authStage = undefined;
    job.status = previousStatus === 'awaiting-auth' ? 'running' : previousStatus;
    log.ok(`Signed in to ${host}; retrying capture.`);

    return await captureVersion(app, version, opts);
  }
}

async function runJob(job: Job, input: AdHocInput): Promise<void> {
  job.status = 'running';

  const detach = addLogSink((level, message) => {
    job.log.push({ level, message, at: Date.now() });
    // Keep memory bounded on long crawls.
    if (job.log.length > 800) job.log.splice(0, job.log.length - 800);
  });

  let manualGate: InMemoryManualGate | undefined;
  if (job.dataEntryMode === 'manual') {
    manualGate = new InMemoryManualGate();
    manualGate.onChange = (queue, activeId) => {
      job.manualQueue = queue;
      job.activeManualId = activeId;
    };
    manualGates.set(job.id, manualGate);
  }

  try {
    const app = buildAdHocConfig(input, job.id);

    // Every sign-in completes before any capture begins.
    await ensureSessions(job, app);

    job.status = 'running';
    const runIds: Partial<Record<VersionId, string>> = {};
    const summary: NonNullable<Job['summary']> = [];
    const failedAuth: VersionId[] = [];

    for (const version of job.versions) {
      try {
        log.info(`Capturing ${version} version…`);
        const { trace } = await captureWithRetry(job, app, version, manualGate);
        runIds[version] = trace.runId;
        summary.push({
          version,
          points: trace.report.pointsCaptured,
          pages: trace.report.pagesVisited,
          screenshots: trace.report.screenshotsCaptured,
          exceptions: trace.report.exceptions.length,
        });
      } catch (err) {
        if (err instanceof SessionError) {
          failedAuth.push(version);
          log.warn(`${version}: sign-in did not complete; skipping this version.`);
          continue;
        }
        throw err;
      }
    }

    if (Object.keys(runIds).length === 0) {
      job.status = 'error';
      job.needsLoginFor = failedAuth;
      job.error =
        failedAuth.length > 0
          ? 'Sign-in did not complete, so no version could be captured.'
          : 'No version could be captured.';
      return;
    }

    if (failedAuth.length > 0) {
      job.needsLoginFor = failedAuth;
      log.warn(
        `Continuing with ${Object.keys(runIds).join(', ')} only; ` +
          `${failedAuth.join(', ')} was skipped.`,
      );
    }

    const jobDir = path.join(OUTPUT_DIR, 'jobs', job.id);
    await mkdir(jobDir, { recursive: true });
    const fileName = `${safeName(app.title)}.docx`;
    const outputPath = path.join(jobDir, fileName);

    await assembleDocument(app, { runIds, outputPath });

    job.documentPath = outputPath;
    job.documentName = fileName;
    job.summary = summary;
    job.runIds = runIds;
    job.status = 'done';
  } catch (err) {
    job.status = 'error';
    job.error = err instanceof Error ? err.message : String(err);
    log.error(job.error);
  } finally {
    job.authStage = undefined;
    manualGates.delete(job.id);
    remoteControls.delete(job.id);
    loginRemoteControls.delete(job.id);
    detach();
    job.finishedAt = Date.now();
  }
}

export interface StandaloneLoginOutcome {
  status: 'pending' | 'done';
  error?: string;
}

/** One entry per in-progress standalone sign-in (the main page's "Sign in" button, not tied to a job). */
const standaloneLoginOutcomes = new Map<string, StandaloneLoginOutcome>();

/** Used by /api/logins/:id to poll whether a standalone sign-in has finished. */
export function getStandaloneLoginOutcome(id: string): StandaloneLoginOutcome | undefined {
  return standaloneLoginOutcomes.get(id);
}

/**
 * Starts a standalone sign-in (the main page's "Sign in" button, used before
 * any job exists) and returns immediately with an id the caller can use to
 * open the live view (`getLoginRemoteControl(id)`, same map a job-driven
 * sign-in populates) and poll for completion (`getStandaloneLoginOutcome`).
 *
 * Runs in the background rather than being awaited here: the caller needs
 * the id right away, before sign-in completes, so it can open the live view
 * while the operator is still signing in — not after.
 */
export function startStandaloneLogin(url: string, userId?: string): string {
  const id = randomUUID();
  standaloneLoginOutcomes.set(id, { status: 'pending' });

  const app = buildAdHocConfig({ newUrl: url, userId }, 'login');
  captureLogin(app, 'new', {
    onRemoteControlReady: (remote) => {
      loginRemoteControls.set(id, remote);
    },
  })
    .then(() => {
      standaloneLoginOutcomes.set(id, { status: 'done' });
    })
    .catch((err) => {
      standaloneLoginOutcomes.set(id, {
        status: 'done',
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      loginRemoteControls.delete(id);
      // Keep the outcome around briefly for a slow poller to still read it, then GC it.
      setTimeout(() => standaloneLoginOutcomes.delete(id), 5 * 60_000);
    });

  return id;
}

/**
 * Starts summary generation for a finished job, if it hasn't been started
 * already (the client can fire this more than once — e.g. on reconnect — and
 * generation is not cheap or idempotent-safe to repeat).
 *
 * Produces both summaries the UI's two tabs need: the deterministic
 * "General Summary" and the LLM-written "AI Summary". They run concurrently
 * and independently, so a failed LLM call still leaves a usable General tab.
 * Callers read both off the job via the existing status poll, the same
 * pattern the rest of this file uses for everything else long-running.
 */
export function requestAiSummary(jobId: string): { ok: true } | { ok: false; error: string } {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, error: 'Unknown job' };
  if (job.status !== 'done' || !job.runIds || Object.keys(job.runIds).length === 0) {
    return { ok: false, error: 'This job has no captured version to summarise yet.' };
  }
  if (job.aiSummaryStatus === 'running' || job.aiSummaryStatus === 'done') {
    return { ok: true };
  }

  job.aiSummaryStatus = 'running';
  job.aiSummaryError = undefined;

  // Deterministic summary runs on its own track — the General tab must not
  // depend on the LLM call succeeding. A failure here has to reach the client
  // as an error state; logging it server-side only would leave the tab
  // waiting forever on a result that is never coming.
  job.generalSummaryStatus = 'running';
  job.generalSummaryError = undefined;
  generateDocumentationPoints(job.runIds)
    .then((general) => {
      job.generalSummary = general;
      job.generalSummaryStatus = 'done';
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      job.generalSummaryStatus = 'error';
      job.generalSummaryError = message;
      log.warn(`Could not build General Summary: ${message}`);
    });

  generateAiDocumentationPoints(job.runIds)
    .then(async (result) => {
      job.aiSummary = result;
      // Rebuild the document with the AI summary appended at the end.
      if (job.documentPath && job.input) {
        try {
          const app = buildAdHocConfig(job.input, job.id);
          await assembleDocument(app, {
            runIds: job.runIds,
            outputPath: job.documentPath,
            aiSummary: result,
          });
          log.ok(`Document updated with AI Summary: ${job.documentPath}`);
        } catch (err) {
          log.warn(`Could not update document with AI summary: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      job.aiSummaryStatus = 'done';
    })
    .catch((err) => {
      job.aiSummaryStatus = 'error';
      job.aiSummaryError = err instanceof Error ? err.message : String(err);
    });

  return { ok: true };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function safeName(title: string): string {
  return title.replace(/[<>:"/\\|?*]/g, '-').trim() || 'document';
}

export { PROJECT_ROOT };
