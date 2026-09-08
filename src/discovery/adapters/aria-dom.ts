import type { Page } from '../../automation/types.js';
import type { ControlKind } from '../../types.js';
import type { RawControl, TechnologyAdapter } from './types.js';
import { walkShadowElements } from '../shared/shadow-walk.js';

/**
 * Plain-DOM control discovery.
 *
 * Fallback for pages that are not UI5, and for custom controls the UI5 registry
 * does not describe. Less precise than the framework probe, so it is only
 * consulted for elements the UI5 probe did not already claim.
 */

export interface DomRawControl {
  domId: string;
  tag: string;
  type: string;
  role: string;
  label: string;
  section: string;
  domOrder: number;
  disabled: boolean;
  readOnly: boolean;
  required: boolean;
  text: string;
  /** Present on accordion/panel toggles and other disclosure widgets. */
  expandable: boolean;
  /**
   * True when an `expandable` control is currently open. Clicking one of
   * these would collapse it rather than reveal anything, so it must not be
   * probed as a generic button; see `ControlDescriptor.alreadyExpanded`.
   */
  expanded: boolean;
  /**
   * True when this field opens a lookup rather than accepting typed text.
   *
   * Typing into one of these does nothing and the attempt simply runs out its
   * timeout, so the distinction has to be made at discovery time even when the
   * UI5 registry is unavailable and only the DOM is visible.
   */
  valueHelp: boolean;
  /** CSS selector that re-resolves this element. */
  selector: string;
}

/** A DOM control, extended with the fields `discoverControls()` needs. */
export interface DomControl extends DomRawControl, RawControl {}

/** Enumerates visible, interactive DOM elements in document order. */
export async function probeDomControls(page: Page): Promise<DomRawControl[]> {
  return page
    .evaluate(() => {
      interface DomRawControl {
        domId: string;
        tag: string;
        type: string;
        role: string;
        label: string;
        section: string;
        domOrder: number;
        disabled: boolean;
        readOnly: boolean;
        required: boolean;
        text: string;
        expandable: boolean;
        expanded: boolean;
        valueHelp: boolean;
        selector: string;
      }

      /**
       * Detects a lookup field: UI5 renders the value-help affordance as a
       * sibling icon inside the control's wrapper, and marks the input as
       * opening a popup.
       */
      const isValueHelp = (el: HTMLElement): boolean => {
        if (/dialog|listbox|grid|tree/i.test(el.getAttribute('aria-haspopup') ?? '')) {
          return true;
        }
        const wrapper = el.closest(
          '.sapMInputBase, .sapMInput, .sapMInputBaseContentWrapper',
        );
        if (
          wrapper?.querySelector(
            '.sapMInputValHelp, .sapMInputValHelpInner, [id$="-vhi"]',
          )
        ) {
          return true;
        }
        return false;
      };

      /**
       * True when a disclosure toggle is currently open. `aria-expanded` is
       * the general case; `<summary>` has no such attribute of its own and is
       * instead read from its parent `<details>`'s `open` property.
       */
      const isExpanded = (el: HTMLElement): boolean => {
        const aria = el.getAttribute('aria-expanded');
        if (aria !== null) return aria === 'true';
        if (el.tagName === 'SUMMARY') {
          return (el.closest('details') as HTMLDetailsElement | null)?.open === true;
        }
        return false;
      };

      const isVisible = (el: HTMLElement): boolean => {
        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed')
          return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };

      /** Finds a label by <label for>, wrapping label, ARIA, or nearby text. */
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

        const ph = el.getAttribute('placeholder');
        if (ph?.trim()) return ph.trim();

        // Nearest preceding text within the same row/field group.
        const group = el.closest(
          '.sapMFormElement, .sapUiFormElement, tr, .row, [class*="field"]',
        );
        if (group) {
          const lbl = group.querySelector<HTMLElement>(
            'label, .sapMLabel, .sapUiFormLabel',
          );
          if (lbl?.innerText?.trim()) return lbl.innerText.trim();
        }
        return '';
      };

      /** Nearest enclosing section/panel heading. */
      const sectionOf = (el: HTMLElement): string => {
        const container = el.closest(
          '.sapMPanel, .sapUxAPObjectPageSection, section, fieldset, [role="region"]',
        );
        if (!container) return '';
        const heading = container.querySelector<HTMLElement>(
          '.sapMPanelHdr, legend, h1, h2, h3, h4, [role="heading"]',
        );
        return heading?.innerText?.trim() ?? '';
      };

      /**
       * Builds a selector that survives re-discovery.
       *
       * Falls back to a structural path so that controls without an id or name
       * — common for icon-only buttons such as value-help triggers — are still
       * addressable rather than skipped.
       */
      const selectorOf = (el: HTMLElement): string => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const name = el.getAttribute('name');
        if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;

        const parts: string[] = [];
        let node: HTMLElement | null = el;
        while (node && node !== document.body && parts.length < 6) {
          const parent: HTMLElement | null = node.parentElement;
          if (!parent) break;
          const tag = node.tagName.toLowerCase();
          const sameTag = Array.from(parent.children).filter(
            (c) => c.tagName === node!.tagName,
          );
          const idx = sameTag.indexOf(node) + 1;
          parts.unshift(
            sameTag.length > 1 ? `${tag}:nth-of-type(${idx})` : tag,
          );
          if (parent.id) {
            parts.unshift(`#${CSS.escape(parent.id)}`);
            return parts.join(' > ');
          }
          node = parent;
        }
        return parts.length ? `body > ${parts.join(' > ')}` : '';
      };

      const selector =
        'input, textarea, select, button, [role="button"], [role="combobox"], ' +
        '[role="checkbox"], [role="radio"], [role="tab"], [contenteditable="true"], ' +
        // Numeric range / spinner widgets.
        '[role="slider"], [role="spinbutton"], ' +
        // Toggle switches (on/off, equivalent to checkbox).
        '[role="switch"], ' +
        // Expandable tree nodes — clicking opens/closes a branch.
        '[role="treeitem"][aria-expanded], ' +
        // Sortable column headers (Table building block): clicking a column
        // header re-sorts the table, which counts as actionButton interaction.
        '[role="columnheader"][aria-sort], ' +
        // Links and menu items: real navigation targets, not layout anchors.
        'a[href]:not([href=""]), [role="link"], [role="menuitem"], ' +
        '[role="menuitemcheckbox"], [role="menuitemradio"], ' +
        // Expandable sections (accordions, collapsible panels) commonly expose
        // their toggle state via aria-expanded regardless of framework, and
        // <details> is the native disclosure widget.
        '[aria-expanded], summary';

      /*
       * Same application-container rule as the UI5 probe -- see its comment
       * for why neither a shell id nor a UIArea can tell the application from
       * the launchpad across both landscapes. This probe runs on every page
       * whether or not the UI5 probe found anything, and each `page.evaluate`
       * is its own isolated world, so the container is recomputed here rather
       * than shared.
       *
       * The view scope is read from the rendered DOM (UI5 renders a control's
       * id onto its element) instead of the control registry, so this keeps
       * working on a page where the registry is unavailable but UI5 markup is
       * still present.
       */
      // Popups render in the static area, outside the application container.
      const POPUP_ROLES = '[role="dialog"], dialog[open], [role="listbox"], [role="grid"]';

      /*
       * The vote is taken only over elements outside any open popup -- see
       * the UI5 probe's comment for why an open dialog's own results content
       * can otherwise outvote the real form and point appRoot at the dialog.
       */
      const scopeCounts = new Map<string, number>();
      for (const node of Array.from(document.querySelectorAll<HTMLElement>('[id*="--"]'))) {
        const sep = node.id.indexOf('--');
        if (sep <= 0) continue;
        if (node.closest(POPUP_ROLES)) continue;
        const scope = node.id.slice(0, sep);
        /*
         * A scope is only a view id if it names a real element. A shell that
         * builds its own ids out of the entry URL puts a literal `--` into
         * shell markup whenever a URL parameter is empty, inventing scopes
         * that name nothing. Measured on a real capture, those phantoms
         * polled 7 against the actual view's 8 — close enough that a redraw
         * briefly thinning the form lets one win, and since no element
         * answers to it `appRoot` comes back null and the shell stops being
         * filtered at all.
         */
        if (!document.getElementById(scope)) continue;
        scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
      }
      let dominantScope = '';
      let dominantCount = 0;
      for (const [scope, count] of scopeCounts) {
        if (count > dominantCount) {
          dominantCount = count;
          dominantScope = scope;
        }
      }

      let appRoot: HTMLElement | null = null;
      if (dominantScope) {
        const viewEl = document.getElementById(dominantScope);
        if (viewEl) {
          appRoot = viewEl;
          const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
          const semanticObject = ((hash.split('?')[0] ?? '').split('-')[0] ?? '').trim();
          if (semanticObject) {
            let node: HTMLElement | null = viewEl.parentElement;
            while (node && node !== document.body) {
              if (node.id && node.id.indexOf(semanticObject) !== -1) appRoot = node;
              node = node.parentElement;
            }
          }
        }
      }

      const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
      const orderOf = new Map<HTMLElement, number>();
      all.forEach((n, i) => orderOf.set(n, i));

      const out: DomRawControl[] = [];
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));

      candidates.forEach((el) => {
        if (!isVisible(el)) return;
        const input = el as HTMLInputElement;
        const type = (el.getAttribute('type') ?? '').toLowerCase();
        if (type === 'hidden') return;

        // See appRoot above: outside the application's own container is
        // launchpad chrome, whatever this landscape happens to call it.
        if (appRoot && !appRoot.contains(el) && !el.closest(POPUP_ROLES)) {
          return;
        }

        out.push({
          domId: el.id ?? '',
          tag: el.tagName.toLowerCase(),
          type,
          role: el.getAttribute('role') ?? '',
          label: labelOf(el),
          section: sectionOf(el),
          domOrder: orderOf.get(el) ?? Number.MAX_SAFE_INTEGER,
          disabled: !!input.disabled || el.getAttribute('aria-disabled') === 'true',
          readOnly:
            !!input.readOnly || el.getAttribute('aria-readonly') === 'true',
          required:
            !!input.required || el.getAttribute('aria-required') === 'true',
          text: (el.innerText ?? '').trim().slice(0, 120),
          expandable: el.hasAttribute('aria-expanded') || el.tagName === 'SUMMARY',
          expanded: isExpanded(el),
          valueHelp: isValueHelp(el),
          selector: selectorOf(el),
        });
      });

      return out.sort((a, b) => a.domOrder - b.domOrder);
    })
    .catch(() => [] as DomRawControl[]);
}

/** DOM-level fingerprint, used when UI5 introspection is unavailable. */
export async function domFingerprint(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      /*
       * The same visibility test `probeDomControls` uses. `offsetParent` alone
       * stays non-null for a `visibility: hidden` or zero-sized element, so
       * expanding a collapsed panel — which reveals exactly such elements —
       * produced an identical fingerprint, and the button that expanded it was
       * therefore judged to have "revealed nothing" and never documented.
       */
      const visible = Array.from(
        document.querySelectorAll<HTMLElement>(
          'input, textarea, select, button, [role="button"], [role="tab"], ' +
          '[role="slider"], [role="spinbutton"], [role="switch"], ' +
          '[role="treeitem"][aria-expanded], [role="dialog"]',
        ),
      )
        .filter((el) => {
          const style = getComputedStyle(el);
          if (el.offsetParent === null && style.position !== 'fixed') return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          return style.visibility !== 'hidden' && style.display !== 'none';
        })
        .map((el) => `${el.tagName}#${el.id || ''}.${el.className || ''}`.slice(0, 80))
        .sort();
      return `${document.title}||${visible.join('|')}`;
    })
    .catch(() => '');
}

/** Maps a plain DOM element to its documentation kind. */
function kindFromDom(c: DomRawControl): ControlKind {
  /*
   * A lookup field's own <input> is deliberately rendered `readonly` by the
   * framework -- confirmed on a live capture (Company Code, Sales Office
   * Code): the underlying element carries `readonly="readonly"` even though
   * the control is fully interactive through its value-help trigger, by
   * design, to force entry through the popup rather than free typing. Tested
   * before the general readonly exclusion below, or this path -- consulted
   * whenever the UI5 registry hasn't already claimed the control -- silently
   * classifies every value-help field as inert and never attempts it. A
   * value-help field that is genuinely `disabled` (not merely read-only) is
   * still excluded.
   */
  if (c.valueHelp) return c.disabled ? 'readonly' : 'valueHelp';

  if (c.disabled || c.readOnly) return 'readonly';

  if (c.tag === 'select') return 'select';
  if (c.tag === 'textarea') return 'textarea';
  if (c.role === 'tab') return 'tab';

  if (c.tag === 'button' || c.role === 'button') return 'actionButton';

  // Numeric range / spinner: interactive but no overlay — treated as plain input.
  if (c.role === 'slider' || c.role === 'spinbutton') return 'input';

  // On/off toggle switch — same interaction pattern as a checkbox.
  if (c.role === 'switch') return 'checkbox';

  // Expandable tree node — click-and-diff decides reveal vs. action.
  if (c.role === 'treeitem') return 'actionButton';

  // Sortable column header (Table building block) — sorting the table is a
  // meaningful interaction worth probing via click-and-diff.
  if (c.role === 'columnheader') return 'actionButton';

  /*
   * Links, menu items and expandable-section toggles all behave the same way
   * for documentation purposes: clicking one either reveals something (a
   * point) or does not (skipped), which is exactly what the provisional
   * actionButton click-and-diff path already resolves.
   */
  if (
    c.tag === 'a' ||
    c.role === 'link' ||
    c.role === 'menuitem' ||
    c.role === 'menuitemcheckbox' ||
    c.role === 'menuitemradio' ||
    c.expandable
  ) {
    return 'actionButton';
  }

  if (c.tag === 'input') {
    // valueHelp already handled above, ahead of the readonly exclusion.
    switch (c.type) {
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'date':
      case 'datetime-local':
      case 'month':
      case 'week':
      case 'time':
        return 'date';
      case 'file':
        return 'fileUpload';
      case 'range':
        return 'input'; // range slider
      case 'submit':
      case 'button':
      case 'reset':
        return 'actionButton';
      default:
        return 'input';
    }
  }

  if (c.role === 'combobox') return 'select';
  if (c.role === 'listbox') return 'select';
  if (c.role === 'checkbox') return 'checkbox';
  if (c.role === 'radio') return 'radio';
  return 'unknown';
}

/**
 * CSS selector for interactive elements that could appear inside shadow roots
 * of non-framework custom elements.
 */
const SHADOW_INTERACTIVE =
  'input:not([type="hidden"]), textarea, select, button, [role="button"], ' +
  '[role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], ' +
  '[role="slider"], [role="spinbutton"], [role="treeitem"][aria-expanded], ' +
  '[aria-expanded]';

/** The ARIA/DOM technology adapter — the always-last fallback. */
export const ariaDomAdapter: TechnologyAdapter<DomControl> = {
  async detect() {
    return true;
  },

  async probe(page) {
    const raw = await probeDomControls(page);
    const light: DomControl[] = raw.map((c) => ({
      ...c,
      id: c.domId || c.selector,
      alreadyExpanded: c.expandable && c.expanded,
      ...(c.type ? { inputType: c.type } : {}),
    }));

    /*
     * Also surface interactive elements found inside open shadow roots of
     * custom elements that earlier adapters did not claim.  The host element's
     * id is used for deduplication: if a prior adapter (e.g. webcomponents)
     * already claimed that host id, the classifier discards these entries.
     */
    const shadowEntries = await walkShadowElements(page, SHADOW_INTERACTIVE);
    const fromShadow: DomControl[] = shadowEntries
      .filter((e) => e.shadowDepth > 0)
      .map((e): DomControl => ({
        domId: e.shadowHostId,
        tag: e.tagName,
        type: e.attrs['type'] || '',
        role: e.role,
        label: e.label,
        section: e.section,
        domOrder: e.domOrder + 1_000_000,
        disabled: e.disabled,
        readOnly: e.attrs['readonly'] !== undefined,
        required: e.required,
        text: e.text,
        expandable: 'aria-expanded' in e.attrs,
        expanded: e.attrs['aria-expanded'] === 'true',
        valueHelp: false,
        selector: e.hostSelector,
        id: e.shadowHostId || e.hostSelector,
        alreadyExpanded: e.attrs['aria-expanded'] === 'true',
        ...(e.attrs['type'] ? { inputType: e.attrs['type'] } : {}),
      }));

    return [...light, ...fromShadow];
  },

  classify: kindFromDom,
};
