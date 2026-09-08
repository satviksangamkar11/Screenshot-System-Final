import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_DIR } from '../config/load.js';
import type { RunTrace, VersionId } from '../types.js';
import { buildDocumentationModel } from './build-model.js';
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

async function loadTrace(runId: string): Promise<RunTrace> {
  const file = path.join(OUTPUT_DIR, 'runs', runId, 'trace.json');
  return JSON.parse(await readFile(file, 'utf8')) as RunTrace;
}
