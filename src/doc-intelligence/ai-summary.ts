import { chatComplete, llmConfigured } from '../llm/client.js';
import type { AiContext } from './ai-context.js';
import { validRefs } from './ai-context.js';
import type { AiPoint, AiSummaryResult } from './index.js';

/**
 * Turns a deterministic `AiContext` (semantic model + facts + patterns +
 * diff — never raw trace/pixels) into the real, human-readable "AI Summary"
 * via the LLM, then validates every point's cited evidence against the
 * context's evidence catalog before accepting it.
 *
 * A point that cites no valid evidence ref is dropped rather than kept —
 * an unsupported claim is worse than a shorter summary. Any failure (no
 * keys configured, every provider down, malformed response, zero surviving
 * points) throws, and the caller (doc-intelligence/index.ts) falls back to
 * the deterministic pipeline.
 */

interface RawPoint {
  text?: unknown;
  importance?: unknown;
  category?: unknown;
  evidenceRefs?: unknown;
}

interface RawResponse {
  points?: unknown;
  overallChange?: { level?: unknown; text?: unknown };
}

const IMPORTANCE_VALUES = new Set(['high', 'medium', 'low']);
const CATEGORY_VALUES = new Set(['added', 'removed', 'changed', 'state', 'structure', 'behavior']);
const OVERALL_LEVELS = new Set(['no_change', 'minor', 'moderate', 'major']);

function systemPrompt(context: AiContext): string {
  const scope =
    context.type === 'single'
      ? 'You are writing a single-version documentation summary of a captured UI.'
      : 'You are writing an Old-to-New comparison summary of a captured UI.';

  return [
    scope,
    'You are given ONLY deterministic, already-verified facts derived from a real captured browser session — never guess or invent anything not present in that data.',
    'Every point you output MUST cite the "ref" (single mode: an evidence seq number; comparison mode: an "old:<seq>" or "new:<seq>" string) of the evidence catalog entries that support it, in an "evidenceRefs" array. Only cite refs that literally appear in the evidence catalog you were given.',
    'Respond with ONLY a single JSON object, no prose, no markdown fences, matching this shape:',
    context.type === 'single'
      ? '{"points":[{"text":string,"importance":"high"|"medium"|"low","evidenceRefs":[number,...]}]}'
      : '{"points":[{"text":string,"importance":"high"|"medium"|"low","category":"added"|"removed"|"changed"|"state"|"structure"|"behavior","evidenceRefs":[string,...]}],"overallChange":{"level":"no_change"|"minor"|"moderate"|"major","text":string}}',
    // Coverage, not a point count. The deterministic pipeline's job is to find
    // everything; this layer's job is to organise all of it into something
    // readable — so asking for "N points" would silently discard findings the
    // pipeline worked to detect.
    'Cover ALL material supported findings in the data you were given. Do not omit material evidence, and do not stop early — completeness matters more than brevity.',
    'Group related findings into a single point rather than repeating near-identical statements: if several controls in one section share a behaviour, describe the section once and name the controls. Deduplicate aggressively; the goal is complete coverage without redundancy.',
    context.type === 'single'
      ? 'Work through the application in a natural reading order: pages, then sections and tabs, then the controls they contain — covering requiredness, the interactions available, observed states, workflow, dialogs and value helps, validations, and anything that failed or was skipped.'
      : 'Work through the change story in this order: what was added, what was removed, what changed, then behaviour, state, structural and workflow differences.',
    'Prefer clear, complete sentences a non-technical reader can act on: what exists, what changed, what it does, in plain language.',
  ].join('\n');
}

function userPrompt(context: AiContext): string {
  return JSON.stringify(context);
}

function parseJsonResponse(raw: string): RawResponse {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(trimmed) as RawResponse;
}

function sanitizePoints(raw: unknown, refs: Set<string>, comparison: boolean): AiPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: AiPoint[] = [];

  for (const entry of raw) {
    const p = entry as RawPoint;
    if (typeof p.text !== 'string' || !p.text.trim()) continue;

    const importance = IMPORTANCE_VALUES.has(p.importance as string)
      ? (p.importance as AiPoint['importance'])
      : 'medium';

    const category =
      comparison && typeof p.category === 'string' && CATEGORY_VALUES.has(p.category) ? p.category : undefined;

    const citedRefs = Array.isArray(p.evidenceRefs) ? p.evidenceRefs.map((r) => String(r)) : [];
    const validCited = citedRefs.filter((r) => refs.has(r));

    // A claim with no valid supporting evidence is unsupported — drop it.
    if (validCited.length === 0) continue;

    out.push({ text: p.text.trim(), importance, ...(category ? { category } : {}) });
  }

  return out;
}

export async function generateAiSummary(context: AiContext): Promise<AiSummaryResult> {
  if (!llmConfigured()) {
    throw new Error('No LLM API keys configured.');
  }

  const raw = await chatComplete(
    [
      { role: 'system', content: systemPrompt(context) },
      { role: 'user', content: userPrompt(context) },
    ],
    // Generous, because the point count is no longer capped: a truncated
    // response is invalid JSON, which would fail parsing and silently drop the
    // whole summary to the deterministic fallback. Reasoning tokens are drawn
    // from this same budget on Groq's gpt-oss models (see llm/client.ts).
    { temperature: 0.2, maxTokens: 8000, jsonMode: true },
  );

  const parsed = parseJsonResponse(raw);
  const refs = validRefs(context);
  const points = sanitizePoints(parsed.points, refs, context.type === 'comparison');

  if (points.length === 0) {
    throw new Error('AI summary produced no evidence-backed points.');
  }

  if (context.type === 'single') {
    return { type: 'single', points };
  }

  type OverallLevel = 'no_change' | 'minor' | 'moderate' | 'major';
  const level = OVERALL_LEVELS.has(parsed.overallChange?.level as string)
    ? (parsed.overallChange!.level as OverallLevel)
    : (context.overallChange as OverallLevel);
  const text =
    typeof parsed.overallChange?.text === 'string' && parsed.overallChange.text.trim()
      ? parsed.overallChange.text.trim()
      : `${level} change detected between versions.`;

  return { type: 'comparison', points, overallChange: { level, text } };
}
