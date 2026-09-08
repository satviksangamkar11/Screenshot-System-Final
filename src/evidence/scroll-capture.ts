import path from 'node:path';
import type { Page } from '../automation/types.js';

/**
 * Full-page capture as viewport-sized scroll segments.
 *
 * The reference documents capture a long form as a series of consecutive
 * screenfuls — one of them uses twelve for a single "Full Page" point — rather
 * than one tall image. That is not just a stylistic choice: the document
 * embeds every screenshot at a fixed width, so a single very tall capture
 * shrinks into an unreadable strip, while viewport-sized segments stay legible
 * at the same width.
 *
 * Fiori complicates this because the page rarely scrolls the window itself;
 * content lives in an inner scroll container, so `window.scrollTo` moves
 * nothing and a naive loop would photograph the same screenful repeatedly.
 */

export interface ScrollSegmentOptions {
  /** Directory to write the images into. */
  outputDir: string;
  /** Path prefix for each file, e.g. "0042-full-page". */
  baseName: string;
  /** Upper bound on segments, so a very long page cannot run away. */
  maxSegments?: number;
}

/** Describes whatever the page actually scrolls with. */
interface ScrollGeometry {
  /** True when an inner element scrolls rather than the document. */
  usesElement: boolean;
  scrollHeight: number;
  clientHeight: number;
}

const SCROLLER_HANDLE = '__uiDocScroller';

/**
 * Finds the element that actually scrolls, and remembers it on `window` so
 * subsequent scroll calls act on the same one.
 */
async function measure(page: Page): Promise<ScrollGeometry> {
  return page.evaluate((handle: string) => {
    const w = window as unknown as Record<string, unknown>;

    // Prefer the largest genuinely-scrollable element; fall back to the
    // document's own scrolling element.
    let best: HTMLElement | null = null;
    let bestOverflow = 0;

    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow <= 40) continue;
      const style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      const rect = el.getBoundingClientRect();
      // Ignore off-screen or collapsed containers.
      if (rect.width < 200 || rect.height < 200) continue;
      if (overflow > bestOverflow) {
        bestOverflow = overflow;
        best = el;
      }
    }

    const docEl = document.scrollingElement ?? document.documentElement;
    const docOverflow = docEl.scrollHeight - docEl.clientHeight;

    if (best && bestOverflow >= docOverflow) {
      w[handle] = best;
      return {
        usesElement: true,
        scrollHeight: best.scrollHeight,
        clientHeight: best.clientHeight,
      };
    }

    w[handle] = null;
    return {
      usesElement: false,
      scrollHeight: docEl.scrollHeight,
      clientHeight: docEl.clientHeight,
    };
  }, SCROLLER_HANDLE);
}

/** Scrolls the detected scroller to an absolute offset. */
async function scrollTo(page: Page, offset: number): Promise<void> {
  await page.evaluate(
    ({ handle, top }: { handle: string; top: number }) => {
      const w = window as unknown as Record<string, unknown>;
      const el = w[handle] as HTMLElement | null;
      if (el) {
        el.scrollTop = top;
      } else {
        (document.scrollingElement ?? document.documentElement).scrollTop = top;
        window.scrollTo(0, top);
      }
    },
    { handle: SCROLLER_HANDLE, top: offset },
  );
  // Let sticky headers and lazy content settle before the shot.
  await page.waitForTimeout(180);
}

/**
 * Captures the current page as consecutive viewport-sized segments.
 *
 * Returns the written file names, relative to `outputDir`. Always returns at
 * least one, so a page that does not scroll still produces a screenshot.
 */
export async function captureScrollSegments(
  page: Page,
  opts: ScrollSegmentOptions,
): Promise<string[]> {
  const maxSegments = opts.maxSegments ?? 20;
  const written: string[] = [];

  const geometry = await measure(page).catch(() => null);
  const clientHeight = geometry?.clientHeight ?? 0;
  const scrollHeight = geometry?.scrollHeight ?? 0;

  // Overlap slightly so a row split across a boundary is fully readable in one
  // of the two segments.
  const step = Math.max(200, Math.round(clientHeight * 0.9));
  const segments =
    clientHeight > 0 && scrollHeight > clientHeight + 40
      ? Math.min(Math.ceil((scrollHeight - clientHeight) / step) + 1, maxSegments)
      : 1;

  for (let i = 0; i < segments; i++) {
    if (segments > 1) {
      const offset = Math.min(i * step, Math.max(0, scrollHeight - clientHeight));
      await scrollTo(page, offset).catch(() => undefined);
    }

    const fileName =
      segments > 1 ? `${opts.baseName}-${i + 1}.png` : `${opts.baseName}.png`;

    try {
      await page.screenshot({
        path: path.join(opts.outputDir, fileName),
        fullPage: false,
        animations: 'disabled',
      });
      written.push(fileName);
    } catch {
      // A failed segment should not abandon the ones already captured.
      break;
    }
  }

  // Leave the page back at the top so later interactions start predictably.
  if (segments > 1) await scrollTo(page, 0).catch(() => undefined);

  return written;
}
