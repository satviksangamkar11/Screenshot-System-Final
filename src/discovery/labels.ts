import type { AppConfig, Lexicon } from '../config/schema.js';

/**
 * Label canonicalisation.
 *
 * The old and new versions are explored independently, so the only thing making
 * an unchanged field produce an identical document entry in both runs is
 * consistent label resolution. This is that mechanism.
 */

export interface LabelResolver {
  /** Lowercased, whitespace-collapsed key -> canonical label. */
  map: Map<string, string>;
}

/** Builds a resolver from the global lexicon plus per-app overrides. */
export function buildResolver(lexicon: Lexicon, app: AppConfig): LabelResolver {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(lexicon.canonical)) {
    map.set(normaliseKey(k), v);
  }
  // Per-app entries win over the global lexicon.
  for (const [k, v] of Object.entries(app.lexicon)) {
    map.set(normaliseKey(k), v);
  }
  return { map };
}

/** Reduces a label to its lookup key: lowercase, collapsed, unpunctuated. */
export function normaliseKey(label: string): string {
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[:* ]+$/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Resolves a raw label to its canonical form.
 *
 * Falls back to a tidied version of the original when the lexicon has no entry,
 * so an unknown field still produces a sensible document label rather than being
 * dropped.
 */
export function canonicalise(label: string, resolver: LabelResolver): string {
  const key = normaliseKey(label);
  if (!key) return '';
  const hit = resolver.map.get(key);
  if (hit) return hit;
  return tidy(label);
}

/**
 * True when a label carries actual wording.
 *
 * Stray punctuation is common in generated markup — a lone ":" or "." from a
 * layout cell. Such a label identifies nothing, so a control carrying one is
 * neither documented nor, if it is a button, clicked: an unlabelled button can
 * navigate away from the form being documented.
 */
export function hasMeaningfulLabel(label: string): boolean {
  return /[\p{L}\p{N}]/u.test(label ?? '');
}

/** Cleans a label for display without changing its wording. */
function tidy(label: string): string {
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[:* ]+$/g, '')
    .trim();
}
