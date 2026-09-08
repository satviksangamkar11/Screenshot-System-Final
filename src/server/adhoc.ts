import { createHash } from 'node:crypto';
import path from 'node:path';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import type { VersionId } from '../types.js';

/**
 * Ad-hoc application configuration built from pasted URLs.
 *
 * The web front end lets a user document a workflow without first authoring a
 * YAML file. Sessions are keyed by origin rather than by application name, so
 * signing in to a host once serves every later job against that host.
 *
 * On a server shared by more than one person, "signing in once serves every
 * later job" has to mean *for that person*, not for everyone — so the storage
 * path is namespaced under `userId` too (see `../server/userId.ts`). On a
 * single-user deployment this still costs nothing: one person still only
 * signs in to a host once.
 */

/**
 * Confines `userId` to something safe to use as a single path segment.
 *
 * `userId` reaches here from a cookie value, which is client-supplied and
 * therefore untrusted no matter how it was minted — validating again at the
 * point it is turned into a path is what actually matters, not trusting the
 * cookie-issuing code to always have done so. Anything not already the shape
 * `userIdOf` mints (a UUID) collapses to a fixed fallback rather than being
 * used verbatim, which rules out both path traversal (`../../etc`) and two
 * different malformed values colliding on the same directory by accident.
 */
function safeUserId(userId: string | undefined): string {
  if (userId && /^[a-f0-9-]{16,64}$/i.test(userId)) return userId;
  return 'shared';
}

/** Stable, filesystem-safe identifier for a URL's origin. */
export function originSlug(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    return `${host}-${createHash('sha1').update(u.origin).digest('hex').slice(0, 6)}`;
  } catch {
    return createHash('sha1').update(url).digest('hex').slice(0, 12);
  }
}

/**
 * Derives a human-readable title from a Fiori URL.
 *
 * Fiori routes carry the semantic object and action in the hash, which is the
 * closest thing to a workflow name available without opening the application.
 */
export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const hash = decodeURIComponent(u.hash.replace(/^#/, ''));
    const route = hash.split('?')[0] ?? '';
    const target = route.split('-')[0] ?? '';
    const spaced = target
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[-_]+/g, ' ')
      .trim();
    if (spaced) {
      return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return u.hostname;
  } catch {
    return 'UI Documentation';
  }
}

export interface AdHocInput {
  oldUrl?: string;
  newUrl?: string;
  title?: string;
  dataEntryMode?: 'automatic' | 'manual';
  /** Identifies which browser this request came from; see `safeUserId`. */
  userId?: string;
}

/** Builds a validated config covering only the versions actually supplied. */
export function buildAdHocConfig(input: AdHocInput, jobId: string): AppConfig {
  const versions: Record<string, { url: string; storageState: string }> = {};
  const userId = safeUserId(input.userId);

  for (const version of ['old', 'new'] as VersionId[]) {
    const url = version === 'old' ? input.oldUrl : input.newUrl;
    if (!url?.trim()) continue;
    versions[version] = {
      url: url.trim(),
      // Keyed by user then origin: reused across jobs and versions for the
      // same person, isolated from every other person on a shared server.
      storageState: path.join(
        'auth',
        '.storage',
        userId,
        `${originSlug(url)}.json`,
      ),
    };
  }

  const anyUrl = input.newUrl?.trim() || input.oldUrl?.trim() || '';

  return AppConfigSchema.parse({
    name: `job-${jobId}`,
    title: input.title?.trim() || titleFromUrl(anyUrl),
    requiresAuth: true,
    versions,
    dataEntryMode: input.dataEntryMode ?? 'automatic',
  });
}

/** Which versions this config will actually capture. */
export function configuredVersions(app: AppConfig): VersionId[] {
  return (['old', 'new'] as VersionId[]).filter((v) => !!app.versions[v]);
}
