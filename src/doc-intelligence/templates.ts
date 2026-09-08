import type { DocFact } from './facts.js';

/** Matches the `AiPoint` shape in ./index.ts. */
export interface RenderedPoint {
  text: string;
  importance: 'high' | 'medium';
  category?: string;
}

const MIN_POINTS = 3;
const MAX_POINTS = 8;

/** Case-insensitive exact/substring match — good enough to catch near-duplicate facts. */
function isNearDuplicate(text: string, existing: string[]): boolean {
  const norm = text.trim().toLowerCase();
  return existing.some((e) => {
    const other = e.trim().toLowerCase();
    return norm === other || norm.includes(other) || other.includes(norm);
  });
}

/**
 * Selects and caps DocFacts into TL;DR points: HIGH first, then MEDIUM to pad,
 * deduping near-identical text. Pure selection/formatting — no LLM call, no
 * fabricated padding. See "Facts and TL;DR selection" in
 * docs/ai-documentation-intelligence-plan.md.
 */
export function renderSinglePoints(facts: DocFact[]): RenderedPoint[] {
  if (facts.length === 0) {
    return [{ text: 'No documentable UI evidence was captured for this page.', importance: 'medium' }];
  }

  const high = facts.filter((f) => f.importance === 'high');
  const medium = facts.filter((f) => f.importance === 'medium');

  const selected: DocFact[] = [];
  const selectedTexts: string[] = [];

  for (const fact of [...high, ...medium]) {
    if (selected.length >= MAX_POINTS) break;
    if (isNearDuplicate(fact.text, selectedTexts)) continue;
    selected.push(fact);
    selectedTexts.push(fact.text);
  }

  // Fewer than MIN_POINTS distinct facts total: return what's honestly there
  // (0, 1, or 2 points) rather than padding with fabricated content.
  return selected.map((f) => ({ text: f.text, importance: f.importance, category: f.category }));
}
