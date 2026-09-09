import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_DIR } from '../config/load.js';
import { log } from '../util/logger.js';
import type { RunTrace, VersionId } from '../types.js';
import { buildDocumentationModel } from './build-model.js';
import { buildComparisonAiContext, buildSingleAiContext } from './ai-context.js';
import { generateAiSummary } from './ai-summary.js';
import { diffModels } from './diff.js';
import { deriveFacts } from './facts.js';
import { detectPatterns } from './patterns.js';
import { renderSinglePoints } from './templates.js';

/** One rendered documentation point in an `AiSummaryResult`. */
export interface AiPoint {
  text: string;
  importance: 'high' | 'medium' | 'low';
  /** Comparison mode only: "added" | "removed" | "changed" | "state" | "structure" */
  category?: string;
}

/** The contract `document/builder.ts` renders as the AI Summary section. */
export interface AiSummaryResult {
  type: 'single' | 'comparison';
  points: AiPoint[];
  /** Comparison mode only. */
  overallChange?: {
    level: 'no_change' | 'minor' | 'moderate' | 'major';
    text: string;
  };
}

/**
 * Deterministic documentation-intelligence entry point.
 *
 * Derives documentation points from structured trace facts — zero vision
 * calls, zero LLM calls (the optional wording-polish step from plan stage 17
 * has not been wired in yet — the plan says to evaluate whether templates
 * alone are good enough before adding it).
 */
export async function generateDocumentationPoints(
  runIds: Partial<Record<VersionId, string>>,
): Promise<AiSummaryResult> {
  const entries = Object.entries(runIds) as [VersionId, string][];

  if (entries.length === 0) {
    return {
      type: 'single',
      points: [{ text: 'No captured version available for documentation.', importance: 'medium' }],
    };
  }

  if (entries.length === 1) {
    const [, runId] = entries[0]!;
    const trace = await loadTrace(runId);
    const model = buildDocumentationModel(trace);
    const patterns = detectPatterns(model);
    const facts = deriveFacts(model, patterns);
    const points = renderSinglePoints(facts);
    return { type: 'single', points };
  }

  // Two versions: build models independently, then diff.
  const [oldEntry, newEntry] = entries as [[VersionId, string], [VersionId, string]];
  const [oldTrace, newTrace] = await Promise.all([
    loadTrace(oldEntry[1]),
    loadTrace(newEntry[1]),
  ]);
  const [oldModel, newModel] = [
    buildDocumentationModel(oldTrace),
    buildDocumentationModel(newTrace),
  ];
  const diff = diffModels(oldModel, newModel);
  return {
    type: 'comparison',
    points: diff.points.map((p) => ({
      text: p.text,
      importance: p.importance,
      category: p.category,
    })),
    overallChange: { level: diff.overallChange, text: diff.overallText },
  };
}

/**
 * AI-powered documentation entry point — the real "AI Summary" tab.
 *
 * Builds the same semantic model/facts/patterns/diff the deterministic
 * pipeline above computes, bundles them (never raw trace.json or pixels)
 * into an `AiContext`, and asks the LLM for a complete human-readable
 * explanation with every claim tied to real evidence refs. Falls back to
 * `generateDocumentationPoints` (the deterministic pipeline) whenever the
 * LLM path fails for any reason — no keys configured, every provider down,
 * a malformed response, or zero evidence-backed points survived validation.
 */
export async function generateAiDocumentationPoints(
  runIds: Partial<Record<VersionId, string>>,
): Promise<AiSummaryResult> {
  try {
    const entries = Object.entries(runIds) as [VersionId, string][];
    if (entries.length === 0) throw new Error('No captured version available.');

    if (entries.length === 1) {
      const [, runId] = entries[0]!;
      const trace = await loadTrace(runId);
      const model = buildDocumentationModel(trace);
      const context = buildSingleAiContext(trace, model);
      return await generateAiSummary(context);
    }

    const [oldEntry, newEntry] = entries as [[VersionId, string], [VersionId, string]];
    const [oldTrace, newTrace] = await Promise.all([loadTrace(oldEntry[1]), loadTrace(newEntry[1])]);
    const [oldModel, newModel] = [buildDocumentationModel(oldTrace), buildDocumentationModel(newTrace)];
    const diff = diffModels(oldModel, newModel);
    const context = buildComparisonAiContext(oldTrace, newTrace, diff);
    return await generateAiSummary(context);
  } catch (err) {
    log.warn(
      `AI summary generation failed, falling back to deterministic summary: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return generateDocumentationPoints(runIds);
  }
}

async function loadTrace(runId: string): Promise<RunTrace> {
  const file = path.join(OUTPUT_DIR, 'runs', runId, 'trace.json');
  return JSON.parse(await readFile(file, 'utf8')) as RunTrace;
}
