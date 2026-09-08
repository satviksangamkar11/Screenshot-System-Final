import type { ContainerNode, ControlNode, PageDocNode, SectionNode, UiDocumentationModel } from './model.js';
import { detectPatterns, type UiPattern } from './patterns.js';

/**
 * Old/New comparison results, externally visible only via the output categories
 * defined in the plan: ADDED, REMOVED, CHANGED, STRUCTURE, BEHAVIOR, STATE, UNRESOLVED.
 *
 * Internal matcher results (CONFIRMED, multiset counts) stay internal.
 */

export type ExternalDiffCategory =
  | 'added'
  | 'removed'
  | 'changed'
  | 'structure'
  | 'behavior'
  | 'state'
  | 'unresolved';

export interface DiffPoint {
  category: ExternalDiffCategory;
  text: string;
  importance: 'high' | 'medium';
}

export interface ModelDiff {
  points: DiffPoint[];
  overallChange: 'no_change' | 'minor' | 'moderate' | 'major';
  overallText: string;
}

// ── Internal match states ────────────────────────────────────────────────────

type MatchState = 'CONFIRMED' | 'POSSIBLE_RENAME' | 'COMPOSITION_CHANGE' | 'UNRESOLVED';

interface SectionMatch {
  state: MatchState;
  old?: SectionNode;
  new?: SectionNode;
  note?: string;
}

interface ContainerMatch {
  state: MatchState;
  old?: ContainerNode;
  new?: ContainerNode;
  note?: string;
}

interface ControlMatch {
  state: MatchState;
  old?: ControlNode;
  new?: ControlNode;
  note?: string;
}

// ── Section matching ─────────────────────────────────────────────────────────

function matchSections(
  oldSections: SectionNode[],
  newSections: SectionNode[],
): SectionMatch[] {
  const results: SectionMatch[] = [];

  const oldByKey = new Map<string, SectionNode[]>();
  for (const s of oldSections) {
    const k = sectionKey(s);
    oldByKey.set(k, [...(oldByKey.get(k) ?? []), s]);
  }

  const newByKey = new Map<string, SectionNode[]>();
  for (const s of newSections) {
    const k = sectionKey(s);
    newByKey.set(k, [...(newByKey.get(k) ?? []), s]);
  }

  const allKeys = new Set([...oldByKey.keys(), ...newByKey.keys()]);
  for (const key of allKeys) {
    const olds = oldByKey.get(key) ?? [];
    const news = newByKey.get(key) ?? [];

    if (olds.length === 1 && news.length === 1) {
      results.push({ state: 'CONFIRMED', old: olds[0], new: news[0] });
    } else if (olds.length === 0) {
      for (const n of news) results.push({ state: 'CONFIRMED', new: n });
    } else if (news.length === 0) {
      for (const o of olds) results.push({ state: 'CONFIRMED', old: o });
    } else {
      // Count mismatch (N:M including equal counts > 1) → composition change, never pair positionally.
      results.push({
        state: 'COMPOSITION_CHANGE',
        note: `${olds.length} old / ${news.length} new for section key "${key}"`,
      });
    }
  }

  return results;
}

function sectionKey(s: SectionNode): string {
  return s.meaningfulLabel ? s.canonicalLabel.toLowerCase().trim() : '__anonymous__';
}

// ── Container matching (Step 11) ─────────────────────────────────────────────

function containerKey(c: ContainerNode): string {
  const label = c.meaningfulLabel ? c.canonicalLabel.toLowerCase().trim() : '__anonymous__';
  // Identity: type + label — the structural signature (child kinds) is what gets
  // compared INSIDE matched pairs, not used as a matching key. Using children
  // as part of the key would prevent matching a container that gained/lost a
  // control, defeating the purpose of container-level recursion.
  return `${c.containerType}::${label}`;
}

function matchContainers(
  oldContainers: ContainerNode[],
  newContainers: ContainerNode[],
): ContainerMatch[] {
  const results: ContainerMatch[] = [];

  const oldByKey = new Map<string, ContainerNode[]>();
  for (const c of oldContainers) {
    const k = containerKey(c);
    oldByKey.set(k, [...(oldByKey.get(k) ?? []), c]);
  }

  const newByKey = new Map<string, ContainerNode[]>();
  for (const c of newContainers) {
    const k = containerKey(c);
    newByKey.set(k, [...(newByKey.get(k) ?? []), c]);
  }

  const allKeys = new Set([...oldByKey.keys(), ...newByKey.keys()]);
  for (const key of allKeys) {
    const olds = oldByKey.get(key) ?? [];
    const news = newByKey.get(key) ?? [];

    if (olds.length === 1 && news.length === 1) {
      results.push({ state: 'CONFIRMED', old: olds[0], new: news[0] });
    } else if (olds.length === 0) {
      for (const n of news) results.push({ state: 'CONFIRMED', new: n });
    } else if (news.length === 0) {
      for (const o of olds) results.push({ state: 'CONFIRMED', old: o });
    } else {
      results.push({
        state: 'COMPOSITION_CHANGE',
        note: `${olds.length} old / ${news.length} new for container key "${key}"`,
      });
    }
  }

  return results;
}

// ── Control matching (multiset, never positional) ────────────────────────────

function matchControls(
  oldControls: ControlNode[],
  newControls: ControlNode[],
): ControlMatch[] {
  const results: ControlMatch[] = [];

  const oldByKey = multisetByKey(oldControls);
  const newByKey = multisetByKey(newControls);
  const allKeys = new Set([...oldByKey.keys(), ...newByKey.keys()]);

  for (const key of allKeys) {
    const olds = oldByKey.get(key) ?? [];
    const news = newByKey.get(key) ?? [];

    if (olds.length === 1 && news.length === 1) {
      const changed =
        olds[0]!.kind !== news[0]!.kind ||
        olds[0]!.interactionKind !== news[0]!.interactionKind;
      results.push({
        state: 'CONFIRMED',
        old: olds[0],
        new: news[0],
        note: changed ? 'CHANGED' : 'SAME',
      });
    } else if (olds.length === 0) {
      for (const n of news) results.push({ state: 'CONFIRMED', new: n });
    } else if (news.length === 0) {
      for (const o of olds) results.push({ state: 'CONFIRMED', old: o });
    } else {
      results.push({
        state: 'COMPOSITION_CHANGE',
        note: `${olds.length} old vs ${news.length} new controls for "${key}"`,
      });
    }
  }

  return results;
}

function controlKey(c: ControlNode): string {
  const label = c.meaningfulLabel ? c.canonicalLabel.toLowerCase().trim() : '__anonymous__';
  return `${label}::${c.kind}`;
}

function multisetByKey(controls: ControlNode[]): Map<string, ControlNode[]> {
  const map = new Map<string, ControlNode[]>();
  for (const c of controls) {
    const k = controlKey(c);
    map.set(k, [...(map.get(k) ?? []), c]);
  }
  return map;
}

// ── Interaction/capability diff (Step 13) ────────────────────────────────────

/**
 * Checks whether a matched section pair gained or lost high-signal capabilities:
 * value-help fields, reveal buttons (open dialogs), and action buttons.
 * These are section-level capability signals separate from individual control
 * adds/removes — a section losing ALL value-help capability is a higher-level
 * finding than "Company Code was removed."
 */
const CAPABILITY_KINDS = ['valueHelp', 'revealButton', 'actionButton'] as const;
type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

function capabilityLabel(kind: CapabilityKind): string {
  switch (kind) {
    case 'valueHelp': return 'value-help (F4 lookup) capability';
    case 'revealButton': return 'dialog/reveal trigger capability';
    case 'actionButton': return 'action button capability';
  }
}

function allControlsInSection(s: SectionNode): ControlNode[] {
  const controls = [...s.controls];
  for (const c of s.containers) controls.push(...c.controls);
  return controls;
}

function capabilityDiff(oldSection: SectionNode, newSection: SectionNode, sectionName: string): DiffPoint[] {
  const points: DiffPoint[] = [];
  for (const kind of CAPABILITY_KINDS) {
    const hadIt = allControlsInSection(oldSection).some((c) => c.kind === kind);
    const hasIt = allControlsInSection(newSection).some((c) => c.kind === kind);
    if (hadIt && !hasIt) {
      points.push({
        category: 'behavior',
        text: `"${sectionName}" lost its ${capabilityLabel(kind)} — no controls of this type remain in the new version.`,
        importance: 'high',
      });
    } else if (!hadIt && hasIt) {
      points.push({
        category: 'behavior',
        text: `"${sectionName}" gained ${capabilityLabel(kind)} — controls of this type appear in the new version.`,
        importance: 'high',
      });
    }
  }
  return points;
}

// ── Pattern comparison (Step 14) ─────────────────────────────────────────────

function patternKey(p: UiPattern): string {
  return p.normalizedRoles.join(',');
}

function diffPatterns(oldPatterns: UiPattern[], newPatterns: UiPattern[]): DiffPoint[] {
  const points: DiffPoint[] = [];

  const oldByKey = new Map<string, UiPattern>();
  for (const p of oldPatterns) oldByKey.set(patternKey(p), p);

  const newByKey = new Map<string, UiPattern>();
  for (const p of newPatterns) newByKey.set(patternKey(p), p);

  const allKeys = new Set([...oldByKey.keys(), ...newByKey.keys()]);
  for (const key of allKeys) {
    const old = oldByKey.get(key);
    const nw = newByKey.get(key);

    if (old && !nw) {
      points.push({
        category: 'structure',
        text: `Recurring UI pattern "${key}" (${old.occurrences}× in old version) no longer appears in the new version.`,
        importance: 'high',
      });
    } else if (!old && nw) {
      points.push({
        category: 'structure',
        text: `New recurring UI pattern "${key}" appears ${nw.occurrences} times in the new version.`,
        importance: nw.strength === 'strong' ? 'high' : 'medium',
      });
    } else if (old && nw && old.occurrences !== nw.occurrences) {
      points.push({
        category: 'structure',
        text: `Pattern "${key}" changed frequency: ${old.occurrences}× in old version vs ${nw.occurrences}× in new version.`,
        importance: 'medium',
      });
    }
    // Same occurrences → no change point.
  }

  return points;
}

// ── UNRESOLVED detection ─────────────────────────────────────────────────────

/**
 * Emits UNRESOLVED when there is genuinely no defensible basis for any
 * correspondence — specifically: both sides have sections, every match is a
 * COMPOSITION_CHANGE (no one-sided CONFIRMED adds/removes either), AND all
 * of those compositions are for anonymous (unlabelled) section keys.
 *
 * Named N:M sections ("Contact Persons × 2 on each side") are still
 * COMPOSITION_CHANGE — informative, not UNRESOLVED. Fully disjoint sections
 * with different labels are all one-sided CONFIRMED (adds/removes) — also
 * informative. UNRESOLVED is reserved for when we cannot say anything
 * meaningful about even which sections exist or changed.
 */
function detectUnresolved(
  matches: SectionMatch[],
  oldSections: SectionNode[],
  newSections: SectionNode[],
): DiffPoint | null {
  if (oldSections.length === 0 || newSections.length === 0) return null;
  const hasAnyConfirmed = matches.some((m) => m.state === 'CONFIRMED');
  if (hasAnyConfirmed) return null;
  // Only COMPOSITION_CHANGEs remain. Only UNRESOLVED when they are all anonymous —
  // named composition changes are informative as-is.
  const allAnonymous = matches.every((m) => m.note?.includes('__anonymous__'));
  if (!allAnonymous) return null;
  return {
    category: 'unresolved',
    text: 'UI structure changed too significantly between versions to establish a reliable field-level correspondence. Manual review is recommended.',
    importance: 'high',
  };
}

// ── Diff point generation ────────────────────────────────────────────────────

function sectionMatchesToPoints(matches: SectionMatch[]): DiffPoint[] {
  const points: DiffPoint[] = [];

  for (const m of matches) {
    if (m.state === 'COMPOSITION_CHANGE') {
      points.push({ category: 'structure', text: `Section composition changed: ${m.note}`, importance: 'high' });
      continue;
    }
    if (m.state === 'CONFIRMED') {
      if (!m.old && m.new) {
        const name = m.new.meaningfulLabel ? m.new.canonicalLabel : 'An unnamed section';
        points.push({ category: 'added', text: `${name} section was added.`, importance: 'high' });
      } else if (m.old && !m.new) {
        const name = m.old.meaningfulLabel ? m.old.canonicalLabel : 'An unnamed section';
        points.push({ category: 'removed', text: `${name} section was removed.`, importance: 'high' });
      } else if (m.old && m.new) {
        const sectionName = m.new.meaningfulLabel ? m.new.canonicalLabel : 'unnamed section';
        // Step 13: capability diff (high-level section capability gains/losses).
        points.push(...capabilityDiff(m.old, m.new, sectionName));
        // Step 10: direct controls in the section (outside any container).
        points.push(...controlMatchesToPoints(matchControls(m.old.controls, m.new.controls), sectionName));
        // Step 11: container comparison.
        points.push(...containerMatchesToPoints(matchContainers(m.old.containers, m.new.containers), sectionName));
      }
    }
  }

  return points;
}

function containerMatchesToPoints(matches: ContainerMatch[], sectionName: string): DiffPoint[] {
  const points: DiffPoint[] = [];
  for (const m of matches) {
    if (m.state === 'COMPOSITION_CHANGE') {
      points.push({ category: 'structure', text: `Container composition changed in "${sectionName}": ${m.note}`, importance: 'medium' });
      continue;
    }
    if (!m.old && m.new) {
      const name = m.new.meaningfulLabel ? m.new.canonicalLabel : `a ${m.new.containerType}`;
      points.push({ category: 'added', text: `Container "${name}" (${m.new.containerType}) was added in "${sectionName}".`, importance: 'high' });
    } else if (m.old && !m.new) {
      const name = m.old.meaningfulLabel ? m.old.canonicalLabel : `a ${m.old.containerType}`;
      points.push({ category: 'removed', text: `Container "${name}" (${m.old.containerType}) was removed from "${sectionName}".`, importance: 'high' });
    } else if (m.old && m.new) {
      // Recurse into controls within the matched container.
      const containerName = m.new.meaningfulLabel ? m.new.canonicalLabel : m.new.containerType;
      const controlMatches = matchControls(m.old.controls, m.new.controls);
      points.push(...controlMatchesToPoints(controlMatches, `${sectionName} › ${containerName}`));
    }
  }
  return points;
}

function controlMatchesToPoints(matches: ControlMatch[], sectionName: string): DiffPoint[] {
  const points: DiffPoint[] = [];
  for (const m of matches) {
    if (m.state === 'COMPOSITION_CHANGE') {
      points.push({ category: 'structure', text: `Control composition changed in "${sectionName}": ${m.note}`, importance: 'medium' });
      continue;
    }
    if (!m.old && m.new) {
      const label = m.new.meaningfulLabel ? m.new.canonicalLabel : 'An unnamed control';
      points.push({ category: 'added', text: `${label} was added in "${sectionName}".`, importance: 'medium' });
    } else if (m.old && !m.new) {
      const label = m.old.meaningfulLabel ? m.old.canonicalLabel : 'An unnamed control';
      points.push({ category: 'removed', text: `${label} was removed from "${sectionName}".`, importance: 'medium' });
    } else if (m.old && m.new && m.note === 'CHANGED') {
      const label = m.new.meaningfulLabel ? m.new.canonicalLabel : 'A control';
      points.push({ category: 'changed', text: `${label} in "${sectionName}" changed from ${m.old.kind}/${m.old.interactionKind} to ${m.new.kind}/${m.new.interactionKind}.`, importance: 'medium' });
    }
    // Identical controls (note === 'SAME') produce no diff point.
  }
  return points;
}

function allSections(root: PageDocNode): SectionNode[] {
  const out: SectionNode[] = [];
  const visit = (p: PageDocNode) => {
    out.push(...p.sections);
    for (const c of p.children) visit(c);
  };
  visit(root);
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function diffModels(oldModel: UiDocumentationModel, newModel: UiDocumentationModel): ModelDiff {
  const oldSections = allSections(oldModel.root);
  const newSections = allSections(newModel.root);

  const sectionMatches = matchSections(oldSections, newSections);
  const unresolvedPoint = detectUnresolved(sectionMatches, oldSections, newSections);

  let rawPoints: DiffPoint[];
  if (unresolvedPoint) {
    rawPoints = [unresolvedPoint];
  } else {
    rawPoints = sectionMatchesToPoints(sectionMatches);
    // Step 14: pattern comparison — run independently of section matching.
    const oldPatterns = detectPatterns(oldModel);
    const newPatterns = detectPatterns(newModel);
    rawPoints.push(...diffPatterns(oldPatterns, newPatterns));
  }

  // Deduplicate and cap — HIGH first, then MEDIUM, cap at 8.
  const seen = new Set<string>();
  const deduped: DiffPoint[] = [];
  for (const p of rawPoints) {
    const key = p.text.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(p);
    }
  }

  const high = deduped.filter((p) => p.importance === 'high');
  const medium = deduped.filter((p) => p.importance === 'medium');
  const selected = [...high, ...medium].slice(0, 8);

  let overallChange: ModelDiff['overallChange'] = 'no_change';
  let overallText = 'No meaningful UI change detected.';
  if (high.length >= 3) {
    overallChange = 'major';
    overallText = 'Major structural changes were detected between versions.';
  } else if (high.length >= 1) {
    overallChange = 'moderate';
    overallText = 'Moderate changes were detected between versions.';
  } else if (medium.length >= 1) {
    overallChange = 'minor';
    overallText = 'Minor control-level changes were detected between versions.';
  }

  if (selected.length === 0) {
    selected.push({
      category: 'structure',
      text: 'No meaningful UI change — captured UI structure and visible controls remain consistent between versions.',
      importance: 'high',
    });
  }

  return { points: selected, overallChange, overallText };
}
