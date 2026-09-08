import type { Page } from '../../../automation/types.js';
import type { RawControl } from '../types.js';
import { resolveDomLabels } from '../../shared/labels-dom.js';
import { checkVisibility } from '../../shared/visibility.js';
import type { WgRawControl } from './classify.js';

/** A WebGUI control, extended with the fields `discoverControls()` needs. */
export interface WgControl extends WgRawControl, RawControl {}

interface WgElementEntry {
  domId: string;
  /** Id-based selector, for the label/visibility lookups below (`label[for]` can only ever target an id). */
  idSelector: string;
  /** The selector `discoverControls()` gets — see `preferredSelector`. */
  selector: string;
  urClass: string;
  inputType: string;
  disabled: boolean;
  readOnly: boolean;
  hasValueHelp: boolean;
  domOrder: number;
  section: string;
  text: string;
  title: string;
}

/** Enumerates ITS-rendered elements: any `ur*`-classed element, plus native checkbox/radio inputs. */
async function enumerateItsElements(page: Page): Promise<WgElementEntry[]> {
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

      /** First `ur*`-shaped class token on this element, or '' when none. */
      const urClassOf = (el: HTMLElement): string => {
        for (const token of Array.from(el.classList)) {
          if (/^ur[A-Z]/.test(token)) return token;
        }
        return '';
      };

      /**
       * Chooses the selector `discoverControls()` will resolve this control
       * by.
       *
       * WebGUI element ids encode screen coordinates (`M0:0032:I`) and are
       * reassigned every time ITS redraws the dynpro's coordinate grid — a
       * selector built from one stops matching the moment the screen
       * re-renders, even though the field itself never went anywhere. The
       * `name` attribute, by contrast, mirrors the underlying ABAP dynpro
       * field name 1:1 and is therefore stable for the life of the
       * transaction. A radio button is the one exception: its `name`
       * identifies the whole option group, not one button in it, so `name`
       * + `value` together are used instead.
       */
      const preferredSelector = (el: HTMLElement): string => {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const name = el.getAttribute('name');
        if (tag === 'input' && type === 'radio' && name) {
          const value = el.getAttribute('value');
          if (value) return `input[name="${CSS.escape(name)}"][value="${CSS.escape(value)}"]`;
        }
        if (name) return `[name="${CSS.escape(name)}"]`;
        if (el.id) return `#${CSS.escape(el.id)}`;
        return '';
      };

      /**
       * True when an F4 ("possible entries") trigger is attached to this
       * field — as a nested trigger button (the common case: the field's
       * own wrapper carries the id, the F4 button is one of its children,
       * addressed by the `id-f4` convention, the same `-f4`/`-vhb`-style
       * suffix every technology here uses for a field's own affordances),
       * or, failing that, as a following sibling.
       */
      const hasSiblingF4 = (el: HTMLElement): boolean => {
        if (el.id && document.getElementById(`${el.id}-f4`)) return true;
        if (el.querySelector('.urF4')) return true;
        let sib: Element | null = el.nextElementSibling;
        for (let hops = 0; sib && hops < 3; hops++, sib = sib.nextElementSibling) {
          if (sib.classList.contains('urF4')) return true;
        }
        return false;
      };

      const seen = new Set<HTMLElement>();
      const candidates: HTMLElement[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('[class]'))) {
        // The F4 trigger itself is an affordance folded into its field's
        // `hasValueHelp` above, not a standalone control in its own right —
        // matching how no adapter here ever separately discovers a value-help
        // or calendar icon as its own control.
        if (el.classList.contains('urF4')) continue;
        if (urClassOf(el) && !seen.has(el)) {
          seen.add(el);
          candidates.push(el);
        }
      }
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>('input[type="checkbox"], input[type="radio"]'),
      )) {
        if (!seen.has(el)) {
          seen.add(el);
          candidates.push(el);
        }
      }

      const out: WgElementEntry[] = [];
      for (const el of candidates) {
        if (!el.id) continue; // needed for the label/visibility lookups below
        const input = el as HTMLInputElement;
        const tag = el.tagName.toLowerCase();
        out.push({
          domId: el.id,
          idSelector: `#${CSS.escape(el.id)}`,
          selector: preferredSelector(el) || `#${CSS.escape(el.id)}`,
          urClass: urClassOf(el),
          inputType: tag === 'input' ? (el.getAttribute('type') || '').toLowerCase() : '',
          disabled: !!input.disabled || el.getAttribute('aria-disabled') === 'true',
          readOnly:
            !!input.readOnly ||
            el.getAttribute('aria-readonly') === 'true' ||
            el.hasAttribute('readonly'),
          hasValueHelp: hasSiblingF4(el),
          domOrder: orderOf.get(el) ?? Number.MAX_SAFE_INTEGER,
          section: sectionOf(el),
          text: (el.innerText ?? el.textContent ?? '').trim().slice(0, 120),
          title: el.getAttribute('title') || '',
        });
      }
      return out;
    })
    .catch(() => [] as WgElementEntry[]);
}

/**
 * Discovers WebGUI/ITS controls: enumerates `ur*`-classed elements (plus
 * native checkbox/radio inputs, identified structurally rather than by
 * class), and resolves label/visibility through the shared DOM helpers
 * rather than duplicating that logic here.
 */
export async function probeWebGui(page: Page): Promise<WgControl[]> {
  const entries = await enumerateItsElements(page);
  if (entries.length === 0) return [];

  const idSelectors = entries.map((e) => e.idSelector);
  const [labels, visibility] = await Promise.all([
    resolveDomLabels(page, idSelectors),
    checkVisibility(page, idSelectors),
  ]);

  const out: WgControl[] = [];
  for (const e of entries) {
    if (visibility[e.idSelector] === false) continue;

    out.push({
      id: e.domId,
      domId: e.domId,
      selector: e.selector,
      label: labels[e.idSelector] || '',
      text: e.text,
      section: e.section,
      domOrder: e.domOrder,
      required: false,
      alreadyExpanded: false,
      urClass: e.urClass,
      inputType: e.inputType,
      hasValueHelp: e.hasValueHelp,
      disabled: e.disabled,
      readOnly: e.readOnly,
      ...(e.title ? { title: e.title } : {}),
    });
  }
  return out;
}
