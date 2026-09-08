import type { SafetyPolicy } from '../config/schema.js';

/**
 * Destructive-action policy.
 *
 * The engine drives a real business system with dummy data. Clicking Save,
 * Create or Post would produce genuine records, so those buttons are classified
 * without ever being clicked. Because pure action buttons yield no documentation
 * point, refusing to click them costs the document nothing.
 */

export type ClickVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * An additional deny check an adapter can register, consulted after the
 * generic label match. Exists because a control's meaningful text does not
 * always live in the visible label discovery resolved — an icon-only
 * toolbar button whose only textual identity is its `title` attribute is
 * the motivating case (see `adapters/webgui/safety.ts`). Returning `null`
 * defers to the generic verdict; returning a deny overrides it.
 */
export type ExtraDenyCheck = (
  ctx: { label: string; title?: string },
  policy: SafetyPolicy,
) => ClickVerdict | null;

const extraDenyChecks: ExtraDenyCheck[] = [];

/**
 * Registers an adapter-specific deny check, consulted by every future
 * `mayClick` call. Adapters call this once at module load — see
 * `adapters/webgui/index.ts`.
 */
export function registerExtraDenyCheck(check: ExtraDenyCheck): void {
  extraDenyChecks.push(check);
}

/** Decides whether a button with this label (and optional tooltip) may be clicked. */
export function mayClick(label: string, policy: SafetyPolicy, title?: string): ClickVerdict {
  for (const check of extraDenyChecks) {
    const verdict = check({ label, title }, policy);
    if (verdict && !verdict.allowed) return verdict;
  }

  const text = label.trim().toLowerCase();
  if (!text) return { allowed: true };

  // An explicit allow entry wins: these are read-only queries needed to navigate.
  if (policy.allowLabels.some((a) => matches(text, a))) {
    return { allowed: true };
  }

  const hit = policy.denyLabels.find((d) => matches(text, d));
  if (hit) {
    return {
      allowed: false,
      reason: `button labelled "${label}" matches deny rule "${hit}"`,
    };
  }
  return { allowed: true };
}

/**
 * Whole-word match, so "Save" blocks a Save button without also blocking
 * something like "Saved Searches".
 */
function matches(text: string, rule: string): boolean {
  const r = rule.trim().toLowerCase();
  if (!r) return false;
  if (text === r) return true;
  const pattern = new RegExp(`\\b${escapeRegex(r)}\\b`);
  return pattern.test(text);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
