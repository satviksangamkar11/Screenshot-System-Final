import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '../automation/types.js';
import type { AppConfig } from '../config/schema.js';
import { requireVersion, storageStatePath, AUTH_DIR } from '../config/load.js';
import type { VersionId } from '../types.js';
import { RemoteControl } from '../server/remoteControl.js';
import { waitForStability } from './stability.js';
import { installBrowserShims } from './shims.js';
import { log } from '../util/logger.js';
import { launchChrome, ChromeLaunchError, type ChromeInstance } from '../automation/chrome-launcher.js';
import { CDPClient } from '../automation/cdp-client.js';
import { CDPSession } from '../automation/cdp-session.js';
import { PageShim } from '../automation/page-shim.js';
import { saveStorageState, loadStorageState, applyOriginLocalStorage } from '../automation/storage-state.js';

/** Viewport chosen to match the aspect ratio of the reference screenshots. */
export const VIEWPORT = { width: 1600, height: 900 } as const;

export interface Session {
  page: Page;
  close: () => Promise<void>;
}

/** Thrown when the saved session is missing or no longer valid. */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

/**
 * Constructs a CDP-backed session: launches Chrome, attaches to its page
 * target, enables the domains callers rely on, sets the viewport, ignores
 * HTTPS errors, and installs the browser-side shims.
 *
 * This is the single point where chrome-launcher + the CDP transport
 * (Phase A) and the Page/Locator shim (Phase B) are wired together —
 * everything downstream of this function only ever calls methods the shim
 * already implements, matching what the equivalent Playwright
 * `chromium.launch()` + `browser.newContext()` block used to do.
 */
async function constructShimSession(opts: { headless?: boolean } = {}): Promise<{
  chromeInstance: ChromeInstance;
  cdpClient: CDPClient;
  cdpSession: CDPSession;
  page: PageShim;
}> {
  const chromeInstance = await launchChrome({ headless: opts.headless });
  const cdpClient = new CDPClient(chromeInstance.debuggerUrl);
  await cdpClient.connect();

  const targetsResp = (await cdpClient.send('Target.getTargets', {})) as {
    targetInfos: Array<{ targetId: string; type: string }>;
  };
  const pageTarget = targetsResp.targetInfos.find((t) => t.type === 'page');
  if (!pageTarget) {
    await cdpClient.close();
    await chromeInstance.close();
    throw new Error('constructShimSession: no page target found after Chrome launch');
  }

  const attachResp = (await cdpClient.send('Target.attachToTarget', {
    targetId: pageTarget.targetId,
    flatten: true,
  })) as { sessionId: string };

  const cdpSession = new CDPSession(cdpClient, attachResp.sessionId, pageTarget.targetId);
  const page = new PageShim(cdpSession);
  await page.enable();

  await cdpSession.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdpSession.send('Security.setIgnoreCertificateErrors', { ignore: true });

  await installBrowserShims(cdpSession);

  return { chromeInstance, cdpClient, cdpSession, page };
}

async function closeShimSession(chromeInstance: ChromeInstance, cdpSession: CDPSession, cdpClient: CDPClient): Promise<void> {
  await cdpSession.detach().catch(() => undefined);
  await cdpClient.close().catch(() => undefined);
  await chromeInstance.close().catch(() => undefined);
}

/**
 * Opens an authenticated session for one application version.
 *
 * Authentication uses a previously saved storage state (cookies +
 * localStorage) so that SSO and MFA are handled by a human once, rather than
 * by the tool on every run.
 */
export async function openSession(
  app: AppConfig,
  version: VersionId,
  opts: { headless?: boolean } = {},
): Promise<Session> {
  const versionCfg = requireVersion(app, version);
  const statePath = storageStatePath(app, version);

  /*
   * A saved session is used when one exists. When it does not, the application
   * is still opened: many internal applications need no sign-in at all, and
   * failing upfront would block them. Whether authentication is actually
   * required is then decided by what the application renders.
   */
  const useSavedSession = app.requiresAuth && existsSync(statePath);

  const { chromeInstance, cdpClient, cdpSession, page } = await constructShimSession({ headless: opts.headless });

  let savedState: Awaited<ReturnType<typeof loadStorageState>> | null = null;
  if (useSavedSession) {
    savedState = await loadStorageState(cdpSession, statePath);
  }

  const close = async () => {
    await closeShimSession(chromeInstance, cdpSession, cdpClient);
  };

  try {
    log.step(`Opening ${version} version: ${versionCfg.url}`);
    await page.goto(versionCfg.url, {
      waitUntil: 'domcontentloaded',
      timeout: 240_000,
    });

    if (savedState) {
      const currentOrigin = new URL(page.url()).origin;
      await applyOriginLocalStorage(page, savedState, currentOrigin);
    }

    await waitForStability(page as unknown as Page, app.budgets.stabilityTimeoutMs);

    if (app.requiresAuth && (await looksLikeLogin(page as unknown as Page))) {
      await close();
      throw new SessionError(
        useSavedSession
          ? `The saved session for "${app.name}" (${version}) has expired — the ` +
            `application redirected to a sign-in screen. Sign in again.`
          : `"${app.name}" (${version}) requires sign-in before it can be ` +
            `documented. Sign in, then run again.`,
      );
    }
  } catch (err) {
    if (err instanceof SessionError) throw err;
    await close();
    if (err instanceof ChromeLaunchError) {
      throw new Error(`Could not open ${version} version of "${app.name}": ${err.message} (reason: ${err.reason})`);
    }
    throw err;
  }

  return { page: page as unknown as Page, close };
}

/**
 * Detects a login/authentication screen.
 *
 * Session expiry mid-run is the most common failure mode for this class of tool,
 * and it must fail loudly rather than silently documenting a login page.
 */
export async function looksLikeLogin(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (/\/(login|logon|saml2|adfs|oauth2|signin)\b/.test(url)) return true;

  return page
    .evaluate(() => {
      const pwd = document.querySelector<HTMLInputElement>(
        'input[type="password"]',
      );
      if (pwd && pwd.offsetParent !== null) return true;
      const t = (document.title || '').toLowerCase();
      return /\b(log ?on|log ?in|sign ?in|authentication)\b/.test(t);
    })
    .catch(() => false);
}

/**
 * Determines, without showing a window, whether a site requires sign-in.
 *
 * Used before opening an interactive sign-in window so that applications
 * needing no authentication never interrupt the operator. Any failure is
 * reported as "sign-in needed", so an unreachable or slow site surfaces as a
 * visible sign-in attempt rather than a silent skip.
 */
export async function probeNeedsSignIn(
  app: AppConfig,
  version: VersionId,
): Promise<boolean> {
  const versionCfg = requireVersion(app, version);
  const { chromeInstance, cdpClient, cdpSession, page } = await constructShimSession();

  try {
    await page.goto(versionCfg.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await waitForStability(page as unknown as Page, app.budgets.stabilityTimeoutMs);
    return await looksLikeLogin(page as unknown as Page);
  } catch {
    return true;
  } finally {
    await closeShimSession(chromeInstance, cdpSession, cdpClient);
  }
}

/**
 * Launches a headed browser for a one-time manual login and saves the session.
 *
 * Resolves when the operator has finished signing in, detected by the app no
 * longer presenting a login screen.
 */
export async function captureLogin(
  app: AppConfig,
  version: VersionId,
  opts: { onRemoteControlReady?: (remote: RemoteControl) => void } = {},
): Promise<string> {
  const versionCfg = requireVersion(app, version);
  const statePath = storageStatePath(app, version);
  await mkdir(path.dirname(statePath), { recursive: true });
  await mkdir(AUTH_DIR, { recursive: true });

  const { chromeInstance, cdpClient, cdpSession, page } = await constructShimSession();
  const visitedOrigins = new Set<string>();

  const remote = new RemoteControl(page as unknown as Page);

  try {
    await page.goto(versionCfg.url, {
      waitUntil: 'domcontentloaded',
      timeout: 240_000,
    });
    visitedOrigins.add(new URL(page.url()).origin);

    await remote.start();
    opts.onRemoteControlReady?.(remote);

    log.info('');
    log.info('  Sign in using the live view in your browser.');
    log.info('  This will close automatically once you are signed in.');
    log.info('');

    // Poll until the login screen is gone and the app has rendered.
    const deadline = Date.now() + 10 * 60_000;
    let settled = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1500);
      if (page.isClosed()) break;
      visitedOrigins.add(new URL(page.url()).origin);
      if (!(await looksLikeLogin(page as unknown as Page))) {
        await waitForStability(page as unknown as Page, 8000);
        if (!(await looksLikeLogin(page as unknown as Page))) {
          settled = true;
          break;
        }
      }
    }

    if (!settled) {
      throw new SessionError(
        'Timed out waiting for sign-in to complete (10 minutes).',
      );
    }

    await saveStorageState(cdpSession, page, [...visitedOrigins], statePath);
    log.ok(`Session saved: ${statePath}`);
    return statePath;
  } finally {
    await remote.stop().catch(() => undefined);
    await closeShimSession(chromeInstance, cdpSession, cdpClient);
  }
}
