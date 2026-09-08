import type { Page } from '../../../automation/types.js';
import type { RawControl } from '../types.js';
import { resolveDomLabels } from '../../shared/labels-dom.js';
import { checkVisibility } from '../../shared/visibility.js';
import { parseLsdata } from './lsdata.js';
import type { WdRawControl } from './classify.js';

/** A Web Dynpro control, extended with the fields `discoverControls()` needs. */
export interface WdControl extends WdRawControl, RawControl {}

interface WdElementEntry {
  domId: string;
  selector: string;
  raw: string;
  domOrder: number;
  section: string;
  text: string;
  /** True when a sibling `id-vhb` value-help trigger button exists. */
  hasSiblingValueHelp: boolean;
}

/**
 * Enumerates every `[lsdata]`-bearing element in document order.
 *
 * Web Dynpro ids are session-stable and application-authored (`WD01`,
 * `WD02`, ...), so the element's own id is used verbatim as both the domId
 * and the selector — no positional or structural fallback is built here;
 * see `webdynproAdapter.supportsIdSuffixFallback`.
 */
async function enumerateLsdataElements(page: Page): Promise<WdElementEntry[]> {
  return page
    .evaluate(() => {
      const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
      const orderOf = new Map<HTMLElement, number>();
      all.forEach((n, i) => orderOf.set(n, i));

      const sectionOf = (el: HTMLElement): string => {
        const container = el.closest('fieldset, section, [role="region"]');
        if (!container) return '';
        const heading = container.querySelector<HTMLElement>(
          'legend, h1, h2, h3, h4, [role="heading"]',
        );
        return heading?.innerText?.trim() ?? '';
      };

      const nodes = Array.from(document.querySelectorAll<HTMLElement>('[lsdata]'));

      return nodes
        .map((el) => {
          const id = el.id || '';
          if (!id) return null;
          const sibling = document.getElementById(`${id}-vhb`);
          return {
            domId: id,
            selector: `#${CSS.escape(id)}`,
            raw: el.getAttribute('lsdata') || '',
            domOrder: orderOf.get(el) ?? Number.MAX_SAFE_INTEGER,
            section: sectionOf(el),
            text: (el.innerText ?? el.textContent ?? '').trim().slice(0, 120),
            hasSiblingValueHelp: !!sibling,
          };
        })
        .filter((e): e is WdElementEntry => e !== null);
    })
    .catch(() => [] as WdElementEntry[]);
}

/**
 * Discovers Web Dynpro controls: enumerates `[lsdata]` elements, parses each
 * one's metadata via `lsdata.ts`, and resolves label/visibility through the
 * shared DOM helpers rather than duplicating that logic here.
 *
 * An element whose `lsdata` fails to parse is skipped outright — there is no
 * safe way to guess its kind, and a silently-misclassified control is worse
 * than one simply not discovered this sweep.
 */
export async function probeWebDynpro(page: Page): Promise<WdControl[]> {
  const entries = await enumerateLsdataElements(page);
  if (entries.length === 0) return [];

  const selectors = entries.map((e) => e.selector);
  const [labels, visibility] = await Promise.all([
    resolveDomLabels(page, selectors),
    checkVisibility(page, selectors),
  ]);

  const out: WdControl[] = [];
  for (const e of entries) {
    const parsed = parseLsdata(e.raw);
    if (!parsed) continue;
    if (visibility[e.selector] === false) continue;
    if (!parsed.properties.visible) continue;

    const domLabel = labels[e.selector] || '';
    const label = domLabel || parsed.properties.label;

    out.push({
      id: e.domId,
      domId: e.domId,
      selector: e.selector,
      label,
      text: e.text || parsed.properties.value,
      section: e.section,
      domOrder: e.domOrder,
      required: parsed.properties.required,
      alreadyExpanded: false,
      controlType: parsed.controlType,
      disabled: !parsed.properties.enabled,
      readOnly: parsed.properties.readOnly,
      dataType: parsed.properties.dataType,
      hasValueHelp: parsed.properties.valueHelp || e.hasSiblingValueHelp,
    });
  }
  return out;
}
