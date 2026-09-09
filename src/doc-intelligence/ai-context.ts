import type { RunTrace } from '../types.js';
import { deriveFacts, type DocFact } from './facts.js';
import { detectPatterns, type UiPattern } from './patterns.js';
import type { UiDocumentationModel } from './model.js';
import type { ModelDiff } from './diff.js';

/**
 * Builds the bundle of already-derived, deterministic evidence that gets sent
 * to the LLM for AI Summary generation. Never sends `trace.json` or pixels —
 * only the semantic model, facts, patterns, and diff this codebase already
 * computed, plus a compact evidence catalog the model can cite by `seq` so
 * every claim it makes can be checked against something real. See the
 * conversation notes: "I would not send raw trace.json blindly to the API."
 */

/** One evidence entry the model is allowed to cite, keyed by `Evidence.seq`. */
export interface EvidenceCatalogEntry {
  seq: number;
  label: string;
  page: string;
  tab?: string;
  section?: string;
  interactionType: string;
  status: 'ok' | 'exception';
}

export interface PatternSummary {
  roles: string[];
  occurrences: number;
  strength: 'strong' | 'medium';
}

export interface SingleAiContext {
  type: 'single';
  version: string;
  evidenceCatalog: EvidenceCatalogEntry[];
  facts: DocFact[];
  patterns: PatternSummary[];
}

export interface ComparisonAiContext {
  type: 'comparison';
  oldVersion: string;
  newVersion: string;
  /** Namespaced `old:<seq>` / `new:<seq>` so refs stay unambiguous across two traces. */
  evidenceCatalog: (EvidenceCatalogEntry & { ref: string })[];
  diffPoints: { category: string; text: string; importance: 'high' | 'medium' }[];
  overallChange: string;
}

export type AiContext = SingleAiContext | ComparisonAiContext;

function catalogFromTrace(trace: RunTrace): EvidenceCatalogEntry[] {
  return trace.evidence.map((e) => ({
    seq: e.seq,
    label: e.canonicalLabel || e.label,
    page: e.pageTitle,
    tab: e.tab,
    section: e.section,
    interactionType: e.interactionType,
    status: e.status,
  }));
}

function patternSummaries(patterns: UiPattern[]): PatternSummary[] {
  return patterns
    .filter((p) => p.strength !== 'none')
    .map((p) => ({ roles: p.normalizedRoles, occurrences: p.occurrences, strength: p.strength as 'strong' | 'medium' }));
}

export function buildSingleAiContext(trace: RunTrace, model: UiDocumentationModel): SingleAiContext {
  const patterns = detectPatterns(model);
  const facts = deriveFacts(model, patterns);
  return {
    type: 'single',
    version: trace.version,
    evidenceCatalog: catalogFromTrace(trace),
    facts,
    patterns: patternSummaries(patterns),
  };
}

export function buildComparisonAiContext(
  oldTrace: RunTrace,
  newTrace: RunTrace,
  diff: ModelDiff,
): ComparisonAiContext {
  const oldCatalog = catalogFromTrace(oldTrace).map((e) => ({ ...e, ref: `old:${e.seq}` }));
  const newCatalog = catalogFromTrace(newTrace).map((e) => ({ ...e, ref: `new:${e.seq}` }));
  return {
    type: 'comparison',
    oldVersion: oldTrace.version,
    newVersion: newTrace.version,
    evidenceCatalog: [...oldCatalog, ...newCatalog],
    diffPoints: diff.points.map((p) => ({ category: p.category, text: p.text, importance: p.importance })),
    overallChange: diff.overallChange,
  };
}

/** The set of refs a model response is allowed to cite for this context. */
export function validRefs(context: AiContext): Set<string> {
  if (context.type === 'single') {
    return new Set(context.evidenceCatalog.map((e) => String(e.seq)));
  }
  return new Set(context.evidenceCatalog.map((e) => e.ref));
}
