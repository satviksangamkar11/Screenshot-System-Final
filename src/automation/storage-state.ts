import { readFile, writeFile } from 'fs/promises';
import { CDPSession } from './cdp-session.js';
import { PageShim } from './page-shim.js';

export interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface StorageStateOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface StorageState {
  cookies: StorageStateCookie[];
  origins: StorageStateOrigin[];
}

/**
 * Saves cookies + per-origin localStorage to the same JSON shape Playwright's
 * `context.storageState({path})` produces, so files in auth/.storage/ remain
 * byte-compatible across the Playwright -> CDP migration.
 *
 * `origins` lists every distinct origin the page has navigated to during this
 * session (tracked by the caller); each is visited if not already current so
 * its localStorage can be read.
 */
export async function saveStorageState(
  cdpSession: CDPSession,
  page: PageShim,
  visitedOrigins: string[],
  path: string,
): Promise<void> {
  const cookiesResp = (await cdpSession.send('Network.getAllCookies', {})) as {
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite?: 'Strict' | 'Lax' | 'None';
    }>;
  };

  const cookies: StorageStateCookie[] = cookiesResp.cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite ?? 'Lax',
  }));

  const origins: StorageStateOrigin[] = [];
  const currentUrl = page.url();

  for (const origin of visitedOrigins) {
    if (!currentUrl.startsWith(origin)) {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined);
    }

    const entries = await page.evaluate(() => {
      try {
        return JSON.stringify(Object.entries(localStorage));
      } catch {
        return '[]';
      }
    });

    const parsed = JSON.parse(entries as string) as Array<[string, string]>;
    if (parsed.length > 0) {
      origins.push({
        origin,
        localStorage: parsed.map(([name, value]) => ({ name, value })),
      });
    }
  }

  const state: StorageState = { cookies, origins };
  await writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Loads a previously saved storage state: cookies via `Network.setCookie`
 * before the first navigation, and localStorage replayed via `evaluate`
 * once the page has landed on each entry's origin.
 *
 * Reads files written by either the old Playwright path or this CDP path —
 * the JSON shape is identical, so no migration is required.
 */
export async function loadStorageState(cdpSession: CDPSession, path: string): Promise<StorageState> {
  const raw = await readFile(path, 'utf-8');
  const state = JSON.parse(raw) as StorageState;

  for (const cookie of state.cookies) {
    await cdpSession
      .send('Network.setCookie', {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      })
      .catch(() => undefined);
  }

  return state;
}

/** Replays localStorage entries for the origin the page has just navigated to. */
export async function applyOriginLocalStorage(page: PageShim, state: StorageState, currentOrigin: string): Promise<void> {
  const originEntry = state.origins.find((o) => o.origin === currentOrigin);
  if (!originEntry || originEntry.localStorage.length === 0) return;

  await page.evaluate((entries) => {
    for (const [name, value] of entries as Array<[string, string]>) {
      try {
        localStorage.setItem(name, value);
      } catch {
        // Storage disabled or quota exceeded — best effort, matches Playwright's own silent behavior here.
      }
    }
  }, originEntry.localStorage.map((e) => [e.name, e.value]));
}
