import type { Page } from '../../automation/types.js';

/**
 * Deep-walks the DOM including open shadow roots.
 *
 * This is the only module (besides shadow-pierce.ts) that may reference
 * `shadowRoot` — all other code that needs to traverse shadow DOM must
 * import from here rather than accessing shadowRoot inline.
 */

export interface ShadowWalkEntry {
  tagName: string;
  /** The matched element's own id, empty when it has none. */
  domId: string;
  /** The id of the nearest light-DOM shadow host ancestor; empty at depth 0. */
  shadowHostId: string;
  /**
   * Selector usable from light DOM for interaction:
   *   depth 0 → the element's own CSS selector
   *   depth > 0 → the immediate shadow host's CSS selector
   */
  hostSelector: string;
  role: string;
  label: string;
  section: string;
  domOrder: number;
  text: string;
  disabled: boolean;
  required: boolean;
  /** All HTML attributes of the matched element as key→value pairs. */
  attrs: Record<string, string>;
  /** 0 = light DOM; ≥1 = inside that many shadow roots. */
  shadowDepth: number;
}

/**
 * Returns every element in the page matching `matchSelector`, found at any
 * shadow depth.  Entries include the information the discovery and interaction
 * layers need without those layers ever touching `shadowRoot` themselves.
 */
export async function walkShadowElements(
  page: Page,
  matchSelector: string,
): Promise<ShadowWalkEntry[]> {
  return page
    .evaluate((sel: string) => {
      interface Entry {
        tagName: string;
        domId: string;
        shadowHostId: string;
        hostSelector: string;
        role: string;
        label: string;
        section: string;
        domOrder: number;
        text: string;
        disabled: boolean;
        required: boolean;
        attrs: Record<string, string>;
        shadowDepth: number;
      }

      let seq = 0;

      function selfSel(el: Element): string {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const name = el.getAttribute('name');
        if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        return el.tagName.toLowerCase();
      }

      function labelOf(el: Element): string {
        const accessible =
          el.getAttribute('accessible-name') || el.getAttribute('aria-label');
        if (accessible?.trim()) return accessible.trim();
        if (el.id) {
          const lbl = document.querySelector<HTMLElement>(
            `ui5-label[for="${CSS.escape(el.id)}"], label[for="${CSS.escape(el.id)}"]`,
          );
          if (lbl?.innerText?.trim()) return lbl.innerText.trim();
        }
        const ph = el.getAttribute('placeholder');
        if (ph?.trim()) return ph.trim();
        return '';
      }

      function sectionOf(el: Element): string {
        const c = el.closest('.sapMPanel, section, fieldset, [role="region"]');
        if (!c) return '';
        const h = c.querySelector<HTMLElement>('h1,h2,h3,h4,legend,[role="heading"]');
        return h?.innerText?.trim() ?? '';
      }

      function attrsOf(el: Element): Record<string, string> {
        const out: Record<string, string> = {};
        for (const a of Array.from(el.attributes)) out[a.name] = a.value;
        return out;
      }

      function walk(
        root: Document | ShadowRoot,
        hostId: string,
        hostSel: string,
        depth: number,
        results: Entry[],
      ): void {
        let matched: Element[];
        try {
          matched = Array.from(root.querySelectorAll(sel));
        } catch {
          matched = [];
        }

        for (const el of matched) {
          const inp = el as HTMLInputElement;
          results.push({
            tagName: el.tagName.toLowerCase(),
            domId: el.id || '',
            shadowHostId: hostId,
            hostSelector: depth === 0 ? selfSel(el) : hostSel,
            role: el.getAttribute('role') || '',
            label: labelOf(el),
            section: sectionOf(el),
            domOrder: seq++,
            text: ((el as HTMLElement).innerText ?? el.textContent ?? '')
              .trim()
              .slice(0, 120),
            disabled:
              inp.disabled ||
              el.getAttribute('aria-disabled') === 'true' ||
              el.hasAttribute('disabled'),
            required:
              inp.required ||
              el.getAttribute('aria-required') === 'true' ||
              el.hasAttribute('required'),
            attrs: attrsOf(el),
            shadowDepth: depth,
          });
        }

        // Recurse into every open shadow root reachable from this root.
        for (const el of Array.from(root.querySelectorAll('*'))) {
          const sr = (el as any).shadowRoot as ShadowRoot | null;
          if (sr) walk(sr, el.id || '', selfSel(el), depth + 1, results);
        }
      }

      const results: Entry[] = [];
      walk(document, '', '', 0, results);
      return results;
    }, matchSelector)
    .catch(() => [] as ShadowWalkEntry[]);
}
