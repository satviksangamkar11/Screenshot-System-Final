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
import { addCaptureSink } from '../evidence/events.js';
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

/**
 * One point whose evidence was confirmed written to disk, for the front end's
 * live capture confirmation. Raised by `EvidenceStore` (see
 * evidence/events.ts) only after the screenshot exists — never when one is
 * merely requested — so the toast the operator sees can be trusted.
 */
export interface JobCapture {
  /**
   * Job-scoped and strictly increasing, which the run's own `seq` is not:
   * that restarts at 1 for the second version, so a two-version job would
   * hand the client repeated ids and it would show each old-version point
   * again while capturing the new one. The client only has to remember the
   * highest id it has shown.
   */
  id: number;
  version: VersionId;
  label: string;
  screenshots: number;
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
  /**
   * Whether each summary is written into the `.docx`. Document-inclusion only:
   * the General Summary is generated for every job either way, and the AI
   * Summary is generated only when the operator's separate AI Summary toggle
   * asked for it. Neither flag can cause a summary to be generated or an LLM
   * call to be made.
   */
  includeGeneralInDoc: boolean;
  includeAiInDoc: boolean;
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
  /** Recent confirmed captures, newest last; only the tail is ever needed. */
  captures: JobCapture[];
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
    includeGeneralInDoc: input.includeGeneralInDoc !== false,
    includeAiInDoc: input.includeAiInDoc !== false,
    input,
    manualQueue: [],
    captures: [],
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

  /*
   * Separate from the log sink on purpose: the front end needs the label and
   * the fact of a successful write as data, not a line of prose it would
   * have to parse back out of the Progress log.
   */
  let captureCounter = 0;
  const detachCaptures = addCaptureSink((event) => {
    job.captures.push({
      id: ++captureCounter,
      version: event.version,
      label: event.label,
      screenshots: event.screenshots,
      at: event.at,
    });
    // The client only ever renders the newest few; the rest is dead weight.
    if (job.captures.length > 60) job.captures.splice(0, job.captures.length - 60);
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

    // Always available, never gated on the AI toggle: it is a pure function of
    // the trace already on disk, costs no API call, and the General tab has to
    // be populated whether or not the operator asked for an AI summary.
    startGeneralSummary(job);
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
    detachCaptures();
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
 * Serialises document rewrites per job. Both summary tracks settle
 * independently and either can finish last, so without this two of them
 * landing together would write the same `.docx` at the same time.
 */
const documentWrites = new Map<string, Promise<void>>();

/**
 * Rewrites the job's document so it carries exactly the summaries the operator
 * asked to include.
 *
 * A summary is written only when it both exists and its inclusion toggle is
 * on, which is the whole of the inclusion rule. This never generates
 * anything: it renders what the two tracks have already produced, so turning
 * an inclusion toggle off cannot suppress generation and turning one on
 * cannot cause an LLM call.
 *
 * Both tracks call this rather than each writing its own idea of the
 * document, so whichever finishes second still produces a file containing
 * both sections instead of overwriting the other's work.
 */
function rebuildDocumentWithSummaries(job: Job): Promise<void> {
  const general = job.includeGeneralInDoc ? job.generalSummary : undefined;
  const ai = job.includeAiInDoc ? job.aiSummary : undefined;

  /*
   * Nothing to add — the document as first written already contains neither
   * section, so rewriting it would be pure risk (a download taken mid-write)
   * for an identical result. This is what keeps an all-off run writing its
   * document exactly once, as it does today.
   */
  if (!general && !ai) return Promise.resolve();
  if (!job.documentPath || !job.input || !job.runIds) return Promise.resolve();

  const { documentPath, input, runIds } = job as Job & {
    documentPath: string;
    input: AdHocInput;
    runIds: Partial<Record<VersionId, string>>;
  };

  const write = (documentWrites.get(job.id) ?? Promise.resolve()).then(async () => {
    try {
      const app = buildAdHocConfig(input, job.id);
      await assembleDocument(app, {
        runIds,
        outputPath: documentPath,
        ...(general ? { generalSummary: general } : {}),
        ...(ai ? { aiSummary: ai } : {}),
      });
      const included = [general ? 'General Summary' : null, ai ? 'AI Summary' : null]
        .filter(Boolean)
        .join(' + ');
      log.ok(`Document updated with ${included}: ${documentPath}`);
    } catch (err) {
      log.warn(
        `Could not update the document with summaries: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  documentWrites.set(job.id, write);
  return write;
}

/**
 * Builds the deterministic "General Summary" for a finished job.
 *
 * Deliberately independent of `requestAiSummary()`: this track involves no
 * LLM and no network, so it runs for every job the moment a document exists,
 * regardless of whether the operator switched the AI Summary toggle on. A
 * failure has to reach the client as an error state — logging it server-side
 * only would leave the General tab waiting forever on a result that is never
 * coming.
 */
function startGeneralSummary(job: Job): void {
  if (!job.runIds || Object.keys(job.runIds).length === 0) return;
  if (job.generalSummaryStatus === 'running' || job.generalSummaryStatus === 'done') return;

  job.generalSummaryStatus = 'running';
  job.generalSummaryError = undefined;

  generateDocumentationPoints(job.runIds)
    .then((general) => {
      job.generalSummary = general;
      job.generalSummaryStatus = 'done';
      /*
       * Deliberately not awaited: the General tab has always appeared the
       * moment this status flips, and making it wait on a document rewrite
       * would change that. The rewrite is independent of what the tab shows.
       */
      void rebuildDocumentWithSummaries(job);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      job.generalSummaryStatus = 'error';
      job.generalSummaryError = message;
      log.warn(`Could not build General Summary: ${message}`);
    });
}

/**
 * Starts the LLM-backed "AI Summary" track for a finished job, if it hasn't
 * been started already (the client can fire this more than once — e.g. on
 * reconnect — and an LLM call is neither cheap nor idempotent-safe to repeat).
 *
 * Called only when the operator has the AI Summary toggle on, so switching it
 * off means no API call is ever made. The General Summary is not started here
 * — see `startGeneralSummary`, which runs for every job either way.
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

  generateAiDocumentationPoints(job.runIds)
    .then(async (result) => {
      job.aiSummary = result;
      // Unchanged ordering: the document is brought up to date before this
      // track reports done, so a download taken at that point already has it.
      await rebuildDocumentWithSummaries(job);
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
