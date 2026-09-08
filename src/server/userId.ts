import { randomUUID } from 'node:crypto';
import type http from 'node:http';

/**
 * Per-browser identity for a shared, multi-user deployment of this server.
 *
 * Saved sessions (`auth/.storage/`) used to be keyed by origin alone: sign in
 * to a host once and every later job against it reused that session. That is
 * correct on one person's own machine, but on a server shared by a team it
 * means the first person to sign in to a host signs in *for everyone* — every
 * other user's capture against that host silently runs as them, under their
 * SAP identity, with no indication it happened.
 *
 * This assigns each browser an opaque id via a first-party cookie (no login
 * of its own, no server-side account) and every session-touching call in
 * `jobs.ts`/`adhoc.ts` is namespaced under it, so two users signing in to the
 * same host get two independent sessions on disk.
 */

const COOKIE_NAME = 'uid';
/** One id per browser profile, effectively indefinitely — 400 days, the cap Chrome enforces on Set-Cookie Max-Age. */
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
/** Matches what `randomUUID()` produces; anything else is treated as absent. */
const VALID_ID = /^[a-f0-9-]{16,64}$/i;

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

/**
 * Reads this request's user id, minting and setting a new one if absent or
 * malformed. The cookie value comes from the client and is never trusted as a
 * filesystem path segment on faith — `VALID_ID` is checked again on every use
 * (see `safeUserId` in `adhoc.ts`), this validation is only what decides
 * whether a fresh id needs minting.
 */
export function userIdOf(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): string {
  const existing = parseCookie(req.headers.cookie, COOKIE_NAME);
  if (existing && VALID_ID.test(existing)) return existing;

  const id = randomUUID();
  // HttpOnly: never needed by the page's own JS. SameSite=Lax: sent on the
  // plain top-level navigation this app is loaded with, not on a cross-site
  // request. No `Secure`: this is an internal tool commonly reached over
  // plain HTTP on a LAN, and `Secure` would silently drop the cookie there.
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${id}; Max-Age=${MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`,
  );
  return id;
}
