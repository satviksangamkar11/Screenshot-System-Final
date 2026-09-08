import type { Page } from '../../automation/types.js';

/**
 * Generic DOM label resolution, shared by adapters that discover their
 * controls from plain markup rather than a framework registry.
 *
 * Tries the common conventions in order: `aria-label`, `aria-labelledby`,
 * an associated `<label for>`, and an enclosing `<label>`. Returns an empty
 * string when none apply — callers decide their own fallback (an adapter's
 * own metadata, adjacent text, etc.).
 */
export async function resolveDomLabels(
  page: Page,
  selectors: string[],
): Promise<Record<string, string>> {
  return page
    .evaluate((sels: string[]) => {
      const labelOf = (el: HTMLElement): string => {
        const aria = el.getAttribute('aria-label');
        if (aria?.trim()) return aria.trim();

        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const parts = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.innerText?.trim() ?? '')
            .filter(Boolean);
          if (parts.length) return parts.join(' ');
        }

        if (el.id) {
          const forLabel = document.querySelector<HTMLElement>(
            `label[for="${CSS.escape(el.id)}"]`,
          );
          if (forLabel?.innerText?.trim()) return forLabel.innerText.trim();
        }

        const wrapping = el.closest('label');
        if (wrapping?.innerText?.trim()) return wrapping.innerText.trim();

        return '';
      };

      const out: Record<string, string> = {};
      for (const sel of sels) {
        try {
          const el = document.querySelector<HTMLElement>(sel);
          out[sel] = el ? labelOf(el) : '';
        } catch {
          out[sel] = '';
        }
      }
      return out;
    }, selectors)
    .catch(() => ({}) as Record<string, string>);
}
