import { createHash } from 'node:crypto';
import type { Page } from '../automation/types.js';
import { primaryFingerprint } from '../discovery/fingerprint.js';

/**
 * State identity for loop protection.
 *
 * Fiori routinely keeps a single URL across many application states, so a
 * URL-keyed signature under-detects loops. Identity is therefore derived from
 * the rendered control tree first, with the URL contributing only as a
 * secondary signal.
 */
export async function fingerprintState(page: Page): Promise<string> {
  const parts: string[] = [];

  parts.push(await primaryFingerprint(page));

  parts.push(await page.title().catch(() => ''));
  parts.push(stripVolatile(page.url()));

  return createHash('sha1').update(parts.join('##')).digest('hex').slice(0, 16);
}

/**
 * Removes parts of a URL that change without the state changing.
 *
 * Cache-busting parameters and session tokens would otherwise make every visit
 * look like a new state and defeat loop detection entirely.
 */
function stripVolatile(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(_|sap-|ts|timestamp|nocache|cachebuster|guid|token)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    return `${u.origin}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}

/**
 * The application-authored structure currently rendered.
 *
 * A framework view registers its own controls under `<viewId>--<controlId>`,
 * and the part from `--` onward is written by whoever authored the view — it
 * is the same identity `stableIdSuffix` already keys controls on, and it does
 * not move when the view is renumbered or when a field's value changes.
 *
 * Two pages of the same application therefore share most of this set, while
 * two different applications share none of it. That makes it the one identity
 * signal available when neither the document title nor the URL distinguishes
 * anything — which is the case for a whole class of single-page shells, where
 * the hosted application never renames the document and never changes the
 * address.
 *
 * Returns an empty list for a page with no such ids, which callers must read
 * as "this signal does not apply here" rather than as "nothing is rendered".
 */
export async function structuralSignature(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const suffixes = new Set<string>();
      for (const node of Array.from(
        document.querySelectorAll<HTMLElement>('[id*="--"]'),
      )) {
        const sep = node.id.indexOf('--');
        if (sep <= 0) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        suffixes.add(node.id.slice(sep));
      }
      return [...suffixes].sort();
    })
    .catch(() => [] as string[]);
}

/**
 * True when nothing that was rendered on the recorded page is rendered now.
 *
 * Deliberately an all-or-nothing test rather than a proportion. Legitimate
 * changes within one page routinely retire most of its structure at once — a
 * tab switch replaces every field on screen — but they always leave the
 * frame that holds them, so some of the recorded structure survives. Only a
 * wholesale replacement of the application leaves none of it, which is
 * exactly the state that must not be documented as if it were the page on
 * record.
 *
 * `recorded.length === 0` means the signal does not apply (an application
 * with no framework-authored ids at all) and is left undecided rather than
 * guessed at. An empty `current`, in contrast, is not given the same benefit
 * of the doubt: it means either the page is genuinely blank — the state a
 * real capture hit right after a field selection triggered a full reload,
 * where every one of the form's fields, its tab bar and all, had vanished
 * together and stayed gone — or a navigation was in flight when the DOM was
 * sampled. Both are exactly the condition this exists to catch. Waving an
 * empty reading through as "unchanged" is what let that capture's own
 * recovery step call the blank page "recovered", and everything after it
 * documented nothing because there was genuinely nothing there.
 */
export function structureFullyReplaced(
  recorded: readonly string[],
  current: readonly string[],
): boolean {
  if (recorded.length === 0) return false;
  const present = new Set(current);
  return !recorded.some((suffix) => present.has(suffix));
}
