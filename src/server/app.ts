import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getJob,
  getLoginRemoteControl,
  getRemoteControl,
  getStandaloneLoginOutcome,
  hasSessionFor,
  requestAiSummary,
  resolveManualStep,
  startJob,
  startStandaloneLogin,
} from './jobs.js';
import { userIdOf } from './userId.js';
import { log } from '../util/logger.js';

/**
 * Minimal HTTP front end.
 *
 * Uses only Node's built-in server: the UI is a single page that collects one
 * or two URLs, starts a job, polls its progress, and offers the finished
 * document for download.
 */

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Rejects anything that is not an http(s) URL, including file: and javascript:. */
function validUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Picks which live view a job's screencast/input endpoints should act on.
 *
 * While a job waits on sign-in, the login RemoteControl is the one showing the
 * sign-in page. Manual mode leaves the capture's own RemoteControl registered
 * from the attempt that just failed, so preferring it there would stream a dead
 * page the operator cannot possibly sign in through.
 */
function remoteForJob(job: { id: string; status: string }) {
  return job.status === 'awaiting-auth'
    ? getLoginRemoteControl(job.id) ?? getRemoteControl(job.id)
    : getRemoteControl(job.id) ?? getLoginRemoteControl(job.id);
}

export function createServer(): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname;

  // --- static ---------------------------------------------------------------
  // `no-store` because the page carries its own JS: a browser holding a cached
  // copy keeps running the previous build's logic against a restarted server,
  // which shows up as UI that contradicts what the server is actually doing.
  if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
    const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }

  // --- full-tab live view -----------------------------------------------------
  // The same screencast the main page embeds, in a window of its own. Signing
  // in to a real system means SSO redirects, password managers and certificate
  // prompts, which need more room than a panel between other panels.
  const livePageMatch = /^\/live\/(jobs|logins)\/([a-z0-9-]+)$/i.exec(route);
  if (req.method === 'GET' && livePageMatch) {
    const html = await readFile(path.join(PUBLIC_DIR, 'live.html'), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }

  // --- does this host already have a saved session? -------------------------
  // Scoped to this browser: on a server shared by several people, whether
  // *someone* has signed in to a host is not the question — whether *this*
  // person has is. See `userIdOf`.
  if (req.method === 'GET' && route === '/api/session') {
    const userId = userIdOf(req, res);
    const target = validUrl(url.searchParams.get('url'));
    if (!target) return sendJson(res, 400, { error: 'Invalid URL' });
    return sendJson(res, 200, { hasSession: hasSessionFor(target, userId) });
  }

  // --- interactive sign-in ----------------------------------------------------
  // Returns immediately with an id: the operator signs in through the live
  // view (below), which needs the id before sign-in completes, not after.
  if (req.method === 'POST' && route === '/api/login') {
    const userId = userIdOf(req, res);
    const body = (await readBody(req)) as { url?: string };
    const target = validUrl(body.url);
    if (!target) return sendJson(res, 400, { error: 'Invalid URL' });

    const loginId = startStandaloneLogin(target, userId);
    return sendJson(res, 202, { loginId });
  }

  // --- standalone sign-in: poll for completion ---------------------------------
  const loginStatusMatch = /^\/api\/logins\/([a-z0-9-]+)$/i.exec(route);
  if (req.method === 'GET' && loginStatusMatch) {
    const outcome = getStandaloneLoginOutcome(loginStatusMatch[1]!);
    if (!outcome) return sendJson(res, 404, { error: 'Unknown login' });
    return sendJson(res, 200, outcome);
  }

  // --- standalone sign-in: live view (Server-Sent Events) ----------------------
  const loginScreencastMatch = /^\/api\/logins\/([a-z0-9-]+)\/screencast$/i.exec(route);
  if (req.method === 'GET' && loginScreencastMatch) {
    const remote = getLoginRemoteControl(loginScreencastMatch[1]!);
    if (!remote) return sendJson(res, 404, { error: 'No live view for this sign-in.' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });

    const unsubscribe = remote.onFrame((jpegBase64) => {
      res.write(`data: ${JSON.stringify({ image: jpegBase64 })}\n\n`);
    });

    req.on('close', unsubscribe);
    return;
  }

  // --- standalone sign-in: forward a click/key/typed text into the live page ---
  const loginInputMatch = /^\/api\/logins\/([a-z0-9-]+)\/input$/i.exec(route);
  if (req.method === 'POST' && loginInputMatch) {
    const remote = getLoginRemoteControl(loginInputMatch[1]!);
    if (!remote) return sendJson(res, 404, { error: 'No live view for this sign-in.' });

    const body = (await readBody(req)) as {
      type?: string;
      x?: number;
      y?: number;
      key?: string;
      value?: string;
      modifiers?: number;
    };

    if (body.type === 'click' && typeof body.x === 'number' && typeof body.y === 'number') {
      await remote.click(body.x, body.y);
    } else if (body.type === 'key' && typeof body.key === 'string') {
      await remote.key(body.key, typeof body.modifiers === 'number' ? body.modifiers : 0);
    } else if (body.type === 'text' && typeof body.value === 'string') {
      await remote.insertText(body.value);
    } else {
      return sendJson(res, 400, { error: 'Invalid input event.' });
    }

    return sendJson(res, 200, { ok: true });
  }

  // --- start a job ----------------------------------------------------------
  if (req.method === 'POST' && route === '/api/generate') {
    const userId = userIdOf(req, res);
    const body = (await readBody(req)) as {
      oldUrl?: string;
      newUrl?: string;
      title?: string;
      dataEntryMode?: string;
    };

    const oldUrl = validUrl(body.oldUrl);
    const newUrl = validUrl(body.newUrl);

    if (!oldUrl && !newUrl) {
      return sendJson(res, 400, {
        error: 'Enter at least one URL (old, new, or both).',
      });
    }

    const dataEntryMode = body.dataEntryMode === 'manual' ? 'manual' : 'automatic';

    const job = startJob({
      ...(oldUrl ? { oldUrl } : {}),
      ...(newUrl ? { newUrl } : {}),
      ...(body.title ? { title: body.title } : {}),
      dataEntryMode,
      userId,
    });
    return sendJson(res, 202, {
      jobId: job.id,
      versions: job.versions,
      dataEntryMode: job.dataEntryMode,
    });
  }

  // --- job status -----------------------------------------------------------
  const statusMatch = /^\/api\/jobs\/([a-z0-9-]+)$/i.exec(route);
  if (req.method === 'GET' && statusMatch) {
    const job = getJob(statusMatch[1]!);
    if (!job) return sendJson(res, 404, { error: 'Unknown job' });

    return sendJson(res, 200, {
      id: job.id,
      status: job.status,
      title: job.title,
      versions: job.versions,
      log: job.log.slice(-200),
      error: job.error ?? null,
      authStage: job.authStage ?? null,
      needsLoginFor: job.needsLoginFor ?? [],
      summary: job.summary ?? [],
      documentName: job.documentName ?? null,
      hasDocument: !!job.documentPath,
      dataEntryMode: job.dataEntryMode,
      manualQueue: job.manualQueue,
      activeManualId: job.activeManualId ?? null,
      aiSummaryStatus: job.aiSummaryStatus ?? null,
      aiSummary: job.aiSummary ?? null,
      aiSummaryError: job.aiSummaryError ?? null,
      generalSummaryStatus: job.generalSummaryStatus ?? null,
      generalSummary: job.generalSummary ?? null,
      generalSummaryError: job.generalSummaryError ?? null,
    });
  }

  // --- Summary generation: drives the General Summary / AI Summary tabs -----
  const aiSummaryMatch = /^\/api\/jobs\/([a-z0-9-]+)\/ai-summary$/i.exec(route);
  if (req.method === 'POST' && aiSummaryMatch) {
    const result = requestAiSummary(aiSummaryMatch[1]!);
    if (!result.ok) return sendJson(res, 409, { error: result.error });
    return sendJson(res, 202, { ok: true });
  }

  // --- manual data-entry confirmation ----------------------------------------
  const manualMatch = /^\/api\/jobs\/([a-z0-9-]+)\/manual$/i.exec(route);
  if (req.method === 'POST' && manualMatch) {
    const job = getJob(manualMatch[1]!);
    if (!job) return sendJson(res, 404, { error: 'Unknown job' });

    const body = (await readBody(req)) as { controlId?: string; action?: string };
    const controlId = typeof body.controlId === 'string' ? body.controlId : '';
    const action = body.action === 'skip' ? 'skip' : body.action === 'submit' ? 'submit' : null;

    if (!controlId || !action) {
      return sendJson(res, 400, { error: 'controlId and action ("submit" | "skip") are required.' });
    }

    const ok = resolveManualStep(job.id, controlId, action);
    if (!ok) {
      return sendJson(res, 409, {
        error: 'That element is not currently waiting on confirmation.',
      });
    }
    return sendJson(res, 200, { ok: true });
  }

  // --- manual mode: live view (Server-Sent Events) ---------------------------
  const screencastMatch = /^\/api\/jobs\/([a-z0-9-]+)\/screencast$/i.exec(route);
  if (req.method === 'GET' && screencastMatch) {
    const jobId = screencastMatch[1]!;
    const job = getJob(jobId);
    if (!job) return sendJson(res, 404, { error: 'Unknown job' });
    if (!remoteForJob(job)) return sendJson(res, 404, { error: 'No live view for this job.' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });

    /*
     * Which RemoteControl this job's live view should show changes over the
     * job's life: the login browser while it waits on sign-in, the capture's
     * own browser once sign-in finishes (see remoteForJob, and the maps it
     * reads in jobs.ts, written and deleted as each browser comes and goes).
     * Resolving it once here would pin the stream to whichever browser
     * happened to be current when the operator connected, so that the moment
     * sign-in completes they sit watching a page that has been torn down --
     * no frames arriving and nothing on either side that would recover, since
     * the SSE connection itself stays perfectly healthy and the client's
     * reconnect (see public/index.html) only ever fires on a dropped one.
     *
     * So re-resolve on a timer and move the subscription whenever it changes,
     * holding `current === remoteForJob(getJob(jobId))` for as long as this
     * connection is open. A second's lag on a transition that happens a
     * handful of times per job is imperceptible, and the timer belongs to this
     * one response -- cleared below when the operator's browser goes away.
     */
    let current: ReturnType<typeof remoteForJob>;
    let unsubscribe: (() => void) | undefined;

    const rebind = (): void => {
      const liveJob = getJob(jobId);
      const nextRemote = liveJob ? remoteForJob(liveJob) : undefined;
      if (nextRemote === current) return;

      // Detach from the old browser before attaching to the new one: without
      // this, every transition leaves another dead listener holding a
      // reference to this response.
      unsubscribe?.();
      unsubscribe = undefined;
      current = nextRemote;

      if (current) {
        unsubscribe = current.onFrame((jpegBase64) => {
          res.write(`data: ${JSON.stringify({ image: jpegBase64 })}\n\n`);
        });
      }
    };

    rebind();
    const rebindTimer = setInterval(rebind, 1000);

    req.on('close', () => {
      clearInterval(rebindTimer);
      unsubscribe?.();
      unsubscribe = undefined;
      current = undefined;
    });
    return;
  }

  // --- manual mode: forward a click/key/typed text into the live page --------
  const inputMatch = /^\/api\/jobs\/([a-z0-9-]+)\/input$/i.exec(route);
  if (req.method === 'POST' && inputMatch) {
    const job = getJob(inputMatch[1]!);
    if (!job) return sendJson(res, 404, { error: 'Unknown job' });

    const remote = remoteForJob(job);
    if (!remote) return sendJson(res, 404, { error: 'No live view for this job.' });

    const body = (await readBody(req)) as {
      type?: string;
      x?: number;
      y?: number;
      key?: string;
      value?: string;
      modifiers?: number;
    };

    if (
      !(body.type === 'click' && typeof body.x === 'number' && typeof body.y === 'number') &&
      !(body.type === 'key' && typeof body.key === 'string') &&
      !(body.type === 'text' && typeof body.value === 'string')
    ) {
      return sendJson(res, 400, { error: 'Invalid input event.' });
    }

    // Dispatch failures (stale/disposed page context, CDP error, etc.) must be
    // reported to the operator, not swallowed — a manual field that silently
    // never received its keystrokes is exactly the "verification failed
    // (empty)" symptom this endpoint used to hide.
    try {
      if (body.type === 'click') {
        await remote.click(body.x as number, body.y as number);
      } else if (body.type === 'key') {
        await remote.key(body.key as string, typeof body.modifiers === 'number' ? body.modifiers : 0);
      } else {
        await remote.insertText(body.value as string);
      }
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return sendJson(res, 200, { ok: true });
  }

  // --- document download ----------------------------------------------------
  const docMatch = /^\/api\/jobs\/([a-z0-9-]+)\/document$/i.exec(route);
  if (req.method === 'GET' && docMatch) {
    const job = getJob(docMatch[1]!);
    if (!job?.documentPath) return sendJson(res, 404, { error: 'No document' });

    const info = await stat(job.documentPath);
    res.writeHead(200, {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(
        job.documentName ?? 'document.docx',
      )}"`,
    });
    createReadStream(job.documentPath).pipe(res);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

/** Every non-internal IPv4 address this machine currently has. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

/**
 * Starts the server and logs the address(es) to open.
 *
 * `listen(port, callback)` with no host binds every interface by default, so
 * this is already reachable from other machines on the network the moment it
 * starts — logging only `localhost` would hide that from whoever runs this as
 * a shared server for a team, leaving them to discover the LAN address some
 * other way.
 */
export function serve(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    /*
     * With no listener here, a bind failure (almost always EADDRINUSE — this
     * server, or something else, already on that port) surfaces as an
     * unhandled 'error' event: Node prints a raw stack trace and the process
     * exits non-deterministically, which is a poor first thing to hit when
     * this is set up to start unattended (a Scheduled Task, a service). The
     * top-level handler in index.ts already turns a rejected `serve()` into a
     * clean one-line error and exit code 1 — this just gives it something
     * worth printing.
     */
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `port ${port} is already in use — is the server already running? ` +
              `Stop it first, or pass -p <port> to use a different one.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      log.ok(`UI Documentation Engine — open http://localhost:${port}`);
      for (const addr of lanAddresses()) {
        log.info(`  also reachable on this network at http://${addr}:${port}`);
      }
      resolve(server);
    });
  });
}
