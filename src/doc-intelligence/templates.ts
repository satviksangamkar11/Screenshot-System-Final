import type { DocFact } from './facts.js';

/** Matches the `AiPoint` shape in ./index.ts. */
export interface RenderedPoint {
  text: string;
  importance: 'high' | 'medium';
  category?: string;
}

/** Case-insensitive exact/substring match — good enough to catch near-duplicate facts. */
function isNearDuplicate(text: string, existing: string[]): boolean {
  const norm = text.trim().toLowerCase();
  return existing.some((e) => {
    const other = e.trim().toLowerCase();
    return norm === other || norm.includes(other) || other.includes(norm);
  });
}

/**
 * Orders DocFacts into documentation points: HIGH first, then MEDIUM, deduping
 * near-identical text. Pure selection/formatting — no LLM call, no fabricated
 * padding. See "Facts and TL;DR selection" in
 * docs/ai-documentation-intelligence-plan.md.
 *
 * Every distinct verified fact is returned. There is deliberately no point
 * cap: the deterministic pipeline's job is to report everything it established,
 * and truncating at an arbitrary count silently hid facts it had already
 * proven. Near-duplicate filtering is what keeps the list readable — a length
 * limit only made it incomplete.
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
    if (isNearDuplicate(fact.text, selectedTexts)) continue;
    selected.push(fact);
    selectedTexts.push(fact.text);
  }

  // However few distinct facts there are, return exactly those — 0, 1 or 2 is
  // an honest answer, and padding to reach some minimum would mean inventing
  // content the capture never established.
  return selected.map((f) => ({ text: f.text, importance: f.importance, category: f.category }));
}
