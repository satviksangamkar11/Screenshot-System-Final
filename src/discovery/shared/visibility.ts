import type { Page } from '../../automation/types.js';

/**
 * Generic visibility check, shared by adapters that discover their controls
 * from plain markup and cannot rely on a framework's own visibility flag.
 *
 * True means a non-empty box, not `visibility: hidden`, not `display: none`
 * — the same definition used throughout the discovery layer.
 */
export async function checkVisibility(
  page: Page,
  selectors: string[],
): Promise<Record<string, boolean>> {
  return page
    .evaluate((sels: string[]) => {
      const isVisible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = getComputedStyle(el as HTMLElement);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };

      const out: Record<string, boolean> = {};
      for (const sel of sels) {
        try {
          const el = document.querySelector(sel);
          out[sel] = !!el && isVisible(el);
        } catch {
          out[sel] = false;
        }
      }
      return out;
    }, selectors)
    .catch(() => ({}) as Record<string, boolean>);
}
