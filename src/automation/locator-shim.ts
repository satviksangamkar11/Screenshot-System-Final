import { CDPSession } from './cdp-session.js';
import { log } from '../util/logger.js';

/**
 * The parts of Playwright's selector engine this codebase actually uses.
 *
 * `document.querySelectorAll` is a plain CSS engine: handed `:visible`,
 * `:text-is()` or `:has-text()` it throws `SyntaxError` rather than returning
 * nothing, so every call site using them failed identically and silently —
 * chooser branches ("could not select Organization") and the OK button of a
 * message dialog among them. Those selectors are spread across the interaction
 * layer, so they are supported here rather than rewritten at ~10 call sites
 * into something weaker.
 *
 * Injected per evaluation as a self-contained closure; nothing is left on the
 * page. Semantics follow Playwright's: `:visible` is a non-empty box that is
 * not hidden, `:has-text()` is a whitespace-normalised substring match, and
 * `:text-is()` is an exact match resolving to the *smallest* element holding
 * the text — without that last rule a bare `:text-is("X")` inside a dialog
 * matches every ancestor up to the dialog itself and clicks the wrong thing.
 */
const SELECTOR_ENGINE = `
  function __udeSplitTop(input, sep) {
    const parts = []; let depth = 0, quote = null, start = 0;
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (quote) { if (c === '\\\\') { i++; } else if (c === quote) { quote = null; } continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0 && c === sep) { parts.push(input.slice(start, i)); start = i + 1; }
    }
    parts.push(input.slice(start));
    return parts;
  }

  /* Splits one selector into compounds, remembering the combinator before each. */
  function __udeSteps(sel) {
    const steps = []; let depth = 0, quote = null, buf = '', comb = ' ', i = 0;
    function flush(next) { const css = buf.trim(); if (css) steps.push({ comb: comb, css: css }); buf = ''; comb = next; }
    while (i < sel.length) {
      const c = sel[i];
      if (quote) { buf += c; if (c === '\\\\') { buf += (sel[i + 1] || ''); i += 2; continue; } if (c === quote) quote = null; i++; continue; }
      if (c === '"' || c === "'") { quote = c; buf += c; i++; continue; }
      if (c === '(' || c === '[') { depth++; buf += c; i++; continue; }
      if (c === ')' || c === ']') { depth--; buf += c; i++; continue; }
      if (depth === 0 && (c === '>' || c === '+' || c === '~')) { flush(c); i++; continue; }
      if (depth === 0 && /\\s/.test(c)) {
        let j = i; while (j < sel.length && /\\s/.test(sel[j])) j++;
        const n = sel[j];
        if (n === '>' || n === '+' || n === '~') { i = j; continue; }
        flush(' '); i = j; continue;
      }
      buf += c; i++;
    }
    flush(' ');
    return steps;
  }

  /* Pulls the Playwright pseudo-classes out of one compound, leaving valid CSS. */
  function __udePseudos(css) {
    const pseudos = []; let out = '', i = 0;
    while (i < css.length) {
      if (css[i] === ':') {
        const rest = css.slice(i);
        if (/^:visible(?![-\\w(])/.test(rest)) { pseudos.push({ t: 'visible' }); i += 8; continue; }
        const fn = /^:(text-is|has-text|text)\\(/.exec(rest);
        if (fn) {
          let j = i + fn[0].length, d = 1, q = null, arg = '';
          while (j < css.length && d > 0) {
            const c = css[j];
            if (q) { if (c === '\\\\') { arg += (css[j + 1] || ''); j += 2; continue; } if (c === q) { q = null; j++; continue; } arg += c; j++; continue; }
            if (c === '"' || c === "'") { q = c; j++; continue; }
            if (c === '(') { d++; arg += c; j++; continue; }
            if (c === ')') { d--; j++; if (d === 0) break; arg += ')'; continue; }
            arg += c; j++;
          }
          pseudos.push({ t: fn[1], arg: arg.trim() });
          i = j; continue;
        }
      }
      out += css[i]; i++;
    }
    return { css: out.trim() || '*', pseudos: pseudos };
  }

  function __udeNorm(el) { return (el.textContent || '').replace(/\\s+/g, ' ').trim(); }
  function __udeVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  function __udeResolveOne(sel) {
    const steps = __udeSteps(sel);
    let current = [document];
    for (let si = 0; si < steps.length; si++) {
      const step = steps[si];
      const parsed = __udePseudos(step.css);
      const out = []; const seen = new Set();
      for (let ci = 0; ci < current.length; ci++) {
        const ctx = current[ci];
        const q = (step.comb === ' ' || ctx === document)
          ? parsed.css
          : ':scope ' + step.comb + ' ' + parsed.css;
        const found = ctx.querySelectorAll(q);
        for (let fi = 0; fi < found.length; fi++) {
          const el = found[fi];
          if (!seen.has(el)) { seen.add(el); out.push(el); }
        }
      }
      let filtered = out;
      for (let pi = 0; pi < parsed.pseudos.length; pi++) {
        const p = parsed.pseudos[pi];
        if (p.t === 'visible') filtered = filtered.filter(__udeVisible);
        else if (p.t === 'text-is') filtered = filtered.filter(function (el) { return __udeNorm(el) === p.arg; });
        else if (p.t === 'has-text') filtered = filtered.filter(function (el) { return __udeNorm(el).indexOf(p.arg) !== -1; });
        else if (p.t === 'text') filtered = filtered.filter(function (el) { return __udeNorm(el).toLowerCase().indexOf(p.arg.toLowerCase()) !== -1; });
      }
      const isTextMatch = parsed.pseudos.some(function (p) { return p.t === 'text-is' || p.t === 'text'; });
      if (isTextMatch) {
        filtered = filtered.filter(function (el) {
          return !filtered.some(function (o) { return o !== el && el.contains(o); });
        });
      }
      current = filtered;
    }
    return current;
  }

  function __udeResolve(selector) {
    const outs = []; const seen = new Set();
    const parts = __udeSplitTop(selector, ',');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i].trim();
      if (!p) continue;
      let els = [];
      try { els = __udeResolveOne(p); } catch (e) { els = []; }
      for (let j = 0; j < els.length; j++) {
        if (!seen.has(els[j])) { seen.add(els[j]); outs.push(els[j]); }
      }
    }
    return outs;
  }
`;

export class LocatorShim {
  private index: number = 0;
  private textPredicate: RegExp | null = null;

  constructor(
    private cdpSession: CDPSession,
    private selector: string,
  ) {}

  first(): LocatorShim {
    const copy = new LocatorShim(this.cdpSession, this.selector);
    copy.index = 0;
    copy.textPredicate = this.textPredicate;
    return copy;
  }

  nth(i: number): LocatorShim {
    const copy = new LocatorShim(this.cdpSession, this.selector);
    copy.index = i;
    copy.textPredicate = this.textPredicate;
    return copy;
  }

  filter(opts: { hasText?: string | RegExp }): LocatorShim {
    const copy = new LocatorShim(this.cdpSession, this.selector);
    copy.index = this.index;
    copy.textPredicate = typeof opts.hasText === 'string' ? new RegExp(opts.hasText) : opts.hasText ?? null;
    return copy;
  }

  /**
   * Wraps `body` in the selector engine plus this locator's own resolution,
   * exposing `__udeMatchAll()` and `__udeMatch()` to it. Every method routes
   * through here so selector semantics can only ever be defined in one place.
   */
  private wrap(body: string): string {
    const pred = this.textPredicate
      ? `new RegExp(${JSON.stringify(this.textPredicate.source)}, ${JSON.stringify(this.textPredicate.flags)})`
      : 'null';
    return `
      (function() {
        ${SELECTOR_ENGINE}
        const __selector = ${JSON.stringify(this.selector)};
        const __pred = ${pred};
        const __index = ${this.index};
        function __udeMatchAll() {
          let a = __udeResolve(__selector);
          if (__pred) a = a.filter(function (el) { return __pred.test(el.textContent || ''); });
          return a;
        }
        function __udeMatch() { return __udeMatchAll()[__index] || null; }
        ${body}
      })()
    `;
  }

  async count(): Promise<number> {
    const result = (await this.cdpSession.send('Runtime.evaluate', {
      expression: this.wrap('return __udeMatchAll().length;'),
      returnByValue: true,
    })) as { result?: { value?: number } };

    return result.result?.value ?? 0;
  }

  async click(opts?: { timeout?: number; clickCount?: number }): Promise<void> {
    const timeout = opts?.timeout ?? 30000;
    const clickCount = opts?.clickCount ?? 1;

    return Promise.race([
      (async () => {
        type ClickPoint = { x?: number; y?: number; found?: boolean; blockedBy?: string | null };
        const probe = async (): Promise<ClickPoint | undefined> => {
          const result = (await this.cdpSession.send('Runtime.evaluate', {
            expression: this.getElementActionExpression('click'),
            returnByValue: true,
          })) as { result?: { value?: ClickPoint } };
          return result.result?.value;
        };

        let coords = await probe();

        /*
         * Something covering the target is usually transient -- a busy/block
         * layer still fading out, an overlay mid-close -- so give it a short
         * chance to clear rather than dispatching into it. Bounded well under
         * the caller's own timeout, and on expiry the click is still
         * dispatched exactly as before: this can only turn a silently
         * swallowed click into a landed one, never the reverse.
         */
        const clearDeadline = Date.now() + Math.min(timeout, 2000);
        while (coords?.found && coords.blockedBy && Date.now() < clearDeadline) {
          await new Promise((r) => setTimeout(r, 100));
          coords = await probe();
        }

        if (!coords || !coords.found || coords.x === undefined || coords.y === undefined) {
          throw new Error(`LocatorShim.click: element not found or not actionable`);
        }

        if (coords.blockedBy) {
          // Dispatched anyway (see above), but never silently: a click that
          // lands on something else is the failure mode hardest to diagnose
          // from the outside, so it says so.
          log.warn(
            `  click target is covered by ${coords.blockedBy} — dispatching anyway, it may not register`,
          );
        }

        /*
         * CDP's own multi-click semantics: each successive mousePressed/
         * mouseReleased pair in the same dispatch carries an incrementing
         * clickCount, exactly matching what a real double/triple physical
         * click produces (the browser attributes selectAll-on-triple-click
         * and similar native behavior to this count, not to call repetition).
         */
        for (let count = 1; count <= clickCount; count++) {
          await this.cdpSession.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: coords.x,
            y: coords.y,
            button: 'left',
            clickCount: count,
          });

          await this.cdpSession.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: coords.x,
            y: coords.y,
            button: 'left',
            clickCount: count,
          });
        }
      })(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`click timeout after ${timeout}ms`)), timeout)),
    ]);
  }

  async fill(value: string, opts?: { timeout?: number }): Promise<void> {
    const timeout = opts?.timeout ?? 30000;

    return Promise.race([
      (async () => {
        const result = (await this.cdpSession.send('Runtime.evaluate', {
          expression: this.getElementActionExpression('fill', value),
          returnByValue: true,
        })) as { result?: { value?: { focused?: boolean } } };

        if (!result.result?.value?.focused) {
          throw new Error('LocatorShim.fill: element not found or could not be focused');
        }

        await this.cdpSession.send('Input.insertText', { text: value });
      })(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`fill timeout after ${timeout}ms`)), timeout)),
    ]);
  }

  async evaluate<R, Arg = void>(fn: (el: Element, arg: Arg) => R, arg?: Arg): Promise<R> {
    const result = (await this.cdpSession.send('Runtime.evaluate', {
      expression: this.wrap(`
        const el = __udeMatch();
        if (!el) return undefined;
        return (${fn.toString()})(el, ${JSON.stringify(arg ?? null)});
      `),
      returnByValue: true,
    })) as { result?: { value?: unknown } };

    return result.result?.value as R;
  }

  async isVisible(): Promise<boolean> {
    return this.evaluate((el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.opacity !== '0' &&
        window.getComputedStyle(el).pointerEvents !== 'none'
      );
    });
  }

  async focus(): Promise<void> {
    await this.evaluate((el) => {
      (el as HTMLElement).focus();
    });
  }

  async getAttribute(name: string): Promise<string | null> {
    const value = await this.evaluate((el, attrName) => el.getAttribute(attrName as string), name);
    return value as string | null;
  }

  async innerText(): Promise<string> {
    return this.evaluate((el) => el.textContent || '');
  }

  async selectOption(value: string, _opts?: { timeout?: number }): Promise<void> {
    await this.evaluate((el, val) => {
      if (el instanceof HTMLSelectElement) {
        el.value = val as string;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, value);
  }

  async scrollIntoViewIfNeeded(_opts?: { timeout?: number }): Promise<void> {
    await this.evaluate((el) => {
      el.scrollIntoView({ block: 'center' });
    });
  }

  private getElementActionExpression(action: string, value?: unknown): string {
    if (action === 'click') {
      /*
       * The hit-test matters as much as the coordinates. A click here is a
       * real `Input.dispatchMouseEvent` at a point, so whatever is topmost at
       * that point receives it -- not necessarily the element the locator
       * resolved. Without checking, a transient overlay (a busy/block layer
       * mid-fade, a tooltip, a sticky bar) silently swallows the click while
       * `click()` still reports success, producing the worst possible
       * failure: an action that appears to have happened and did not. This is
       * generic DOM behaviour, not specific to any framework.
       *
       * `blockedBy` uses the same "is the target actually on top" semantics as
       * `waitUntilEditable` in src/interaction/editability.ts -- the element
       * itself, an ancestor, or a descendant at that point all count as
       * clear -- so both places agree on what "covered" means.
       */
      return this.wrap(`
        const el = __udeMatch();
        if (!el) return { found: false };
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return { found: false };
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const top = document.elementFromPoint(x, y);
        const clear = !top || top === el || el.contains(top) || top.contains(el);
        let blockedBy = null;
        if (!clear && top) {
          const cls = top.className;
          const firstClass = typeof cls === 'string' && cls ? '.' + cls.split(' ')[0] : '';
          blockedBy = top.tagName.toLowerCase() + firstClass + (top.id ? '#' + top.id : '');
        }
        return { found: true, x: x, y: y, blockedBy: blockedBy };
      `);
    }

    if (action === 'fill') {
      return this.wrap(`
        const el = __udeMatch();
        if (!el) return { focused: false };
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { focused: true };
      `);
    }

    throw new Error(`Unknown action: ${action}`);
  }
}
