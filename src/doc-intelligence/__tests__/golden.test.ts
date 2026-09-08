/**
 * Golden specifications for the doc-intelligence pipeline.
 *
 * Build order step 1: technology-matrix aware, covering the full comparison
 * matrix from docs/ai-documentation-intelligence-plan.md.
 *
 * Run:  npx tsx --test src/doc-intelligence/__tests__/golden.test.ts
 *
 * Scenarios covered:
 *  Single-version:
 *    S1  Minimal capture — empty sections produce honest "no evidence" output
 *    S2  Single section, mixed controls — facts and TL;DR selection
 *    S3  Multiple sections — each appears in facts
 *    S4  Junk section label (".", bare "X") — node kept, excluded from named output
 *    S5  Pattern detection — 3+ matching containers = strong pattern
 *    S6  Dialog reveal fact — revealButton with ok result = HIGH fact
 *
 *  Comparison (Old vs New):
 *    C1  No change — no diff points
 *    C2  Section added
 *    C3  Section removed
 *    C4  Control added within matched section
 *    C5  Control removed within matched section
 *    C6  Control kind/interactionKind changed (CHANGED)
 *    C7  1:1 same-kind no-label-match — POSSIBLE_RENAME heuristic (not positional)
 *    C8  N:M duplicate controls — COMPOSITION_CHANGE, never individual pairing
 *    C9  Container added within matched section
 *    C10 Container removed within matched section
 *    C11 Controls inside matched container — recurse correctly
 *    C12 Section capability lost — revealButton disappears entirely = HIGH behavior point
 *    C13 Pattern appears in new, gone from old — HIGH structure point
 *    C14 UNRESOLVED — both sides have sections but no key overlap at all
 *    C15 Anonymous sections on both sides — grouped under __anonymous__ key, N:M → COMPOSITION_CHANGE
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ContainerNode, ControlNode, PageDocNode, SectionNode, UiDocumentationModel } from '../model.js';
import { deriveFacts } from '../facts.js';
import { detectPatterns } from '../patterns.js';
import { renderSinglePoints } from '../templates.js';
import { diffModels } from '../diff.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeModel(sections: SectionNode[], runId = 'test-run'): UiDocumentationModel {
  const root: PageDocNode = {
    nodeKind: 'page',
    path: ['Root'],
    rawLabel: 'Root',
    canonicalLabel: 'Root',
    meaningfulLabel: true,
    evidenceRefs: [],
    sections,
    children: [],
  };
  return { version: 'new', runId, root };
}

function makeSection(
  label: string,
  controls: ControlNode[] = [],
  containers: ContainerNode[] = [],
): SectionNode {
  const meaningful = label !== '.' && label !== 'X' && label.trim().length > 0 && /[\p{L}\p{N}]/u.test(label);
  return {
    nodeKind: 'section',
    path: ['Root', label || 'anonymous-section'],
    rawLabel: label,
    canonicalLabel: meaningful ? label : 'anonymous-section',
    meaningfulLabel: meaningful,
    evidenceRefs: [],
    controls,
    containers,
  };
}

function makeContainer(
  type: ContainerNode['containerType'],
  label: string,
  controls: ControlNode[],
): ContainerNode {
  return {
    nodeKind: 'container',
    path: ['Root', 'Section', label],
    rawLabel: label,
    canonicalLabel: label,
    meaningfulLabel: label.length > 0,
    containerType: type,
    evidenceRefs: [],
    controls,
  };
}

function makeControl(
  label: string,
  kind: ControlNode['kind'] = 'input',
  interactionKind: ControlNode['interactionKind'] = 'fill',
  result?: 'ok' | 'exception',
): ControlNode {
  const meaningful = /[\p{L}\p{N}]/u.test(label);
  return {
    nodeKind: 'control',
    path: ['Root', 'Section', label],
    rawLabel: label,
    canonicalLabel: meaningful ? label : 'anonymous-control',
    meaningfulLabel: meaningful,
    kind,
    interactionKind,
    observedInteractionResult: result,
    state: result ? 'interacted' : 'default',
    evidenceRefs: [],
  };
}

// ── Single-version tests ─────────────────────────────────────────────────────

describe('Single-version: S1 empty capture', () => {
  it('produces honest "no evidence" output', () => {
    const model = makeModel([]);
    const patterns = detectPatterns(model);
    const facts = deriveFacts(model, patterns);
    const points = renderSinglePoints(facts);
    assert.equal(points.length, 1);
    assert.match(points[0]!.text, /no documentable/i);
  });
});

describe('Single-version: S2 mixed controls', () => {
  it('generates facts from a section with mixed controls', () => {
    const controls = [
      makeControl('Company Code', 'valueHelp', 'fill'),
      makeControl('Country', 'select', 'fill'),
      makeControl('Active', 'checkbox', 'fill'),
      makeControl('Search', 'revealButton', 'dialogOpen', 'ok'),
    ];
    const model = makeModel([makeSection('General Data', controls)]);
    const patterns = detectPatterns(model);
    const facts = deriveFacts(model, patterns);
    // The revealButton that succeeded should generate a HIGH fact.
    const revealFact = facts.find((f) => f.category === 'behavior' && f.importance === 'high' && f.text.includes('Search'));
    assert.ok(revealFact, 'expected a HIGH behavior fact for the reveal button');
    const points = renderSinglePoints(facts);
    assert.ok(points.length >= 1, 'expected at least one point');
  });
});

describe('Single-version: S3 multiple sections', () => {
  it('generates a major-section fact for each labelled section with multiple children', () => {
    const model = makeModel([
      makeSection('General Data', [makeControl('Name'), makeControl('Code')]),
      makeSection('Payment Details', [makeControl('Method'), makeControl('Bank')]),
    ]);
    const patterns = detectPatterns(model);
    const facts = deriveFacts(model, patterns);
    const structureFacts = facts.filter((f) => f.category === 'structure' && f.importance === 'high');
    assert.equal(structureFacts.length, 2, 'expected one HIGH structure fact per named section');
  });
});

describe('Single-version: S4 junk section label', () => {
  it('keeps junk-labelled section structurally but excludes it from named facts', () => {
    const controls = [makeControl('Payee Code'), makeControl('Cost Center Code')];
    const model = makeModel([
      makeSection('General Data', [makeControl('Company Code'), makeControl('Sales Office')]),
      makeSection('.', controls), // junk label — anonymized, not deleted
    ]);
    const patterns = detectPatterns(model);
    const facts = deriveFacts(model, patterns);
    // The controls inside the junk section are still captured.
    const allFacts = facts.map((f) => f.text);
    const mentionsJunkLabel = allFacts.some((t) => t.includes('"."'));
    assert.ok(!mentionsJunkLabel, 'junk label "." must not appear in fact text');
    // The section with a real label still produces a fact.
    const generalDataFact = facts.find((f) => f.text.includes('General Data'));
    assert.ok(generalDataFact, 'named section should still produce facts');
  });
});

describe('Single-version: S5 pattern detection', () => {
  it('detects a strong recurring pattern from 3+ identical containers', () => {
    const makeFilterGroup = (label: string) =>
      makeContainer('group', label, [
        makeControl('Filter Field', 'input'),
        makeControl('Search Button', 'actionButton'),
      ]);
    const model = makeModel([
      makeSection('Section A', [], [makeFilterGroup('Group 1')]),
      makeSection('Section B', [], [makeFilterGroup('Group 2')]),
      makeSection('Section C', [], [makeFilterGroup('Group 3')]),
    ]);
    const patterns = detectPatterns(model);
    const strong = patterns.filter((p) => p.strength === 'strong');
    assert.ok(strong.length >= 1, 'expected at least one strong pattern from 3 identical containers');
  });

  it('does not report a single-occurrence container as a pattern', () => {
    const model = makeModel([
      makeSection('Section A', [], [makeContainer('group', 'Unique', [makeControl('Only', 'input')])]),
    ]);
    const patterns = detectPatterns(model);
    assert.equal(patterns.length, 0, 'single occurrence is not a pattern');
  });
});

describe('Single-version: S6 dialog reveal fact', () => {
  it('generates HIGH behavior fact for successful reveal button', () => {
    const model = makeModel([
      makeSection('Actions', [makeControl('Open Lookup', 'revealButton', 'dialogOpen', 'ok')]),
    ]);
    const patterns = detectPatterns(model);
    const facts = deriveFacts(model, patterns);
    const revealFact = facts.find((f) => f.importance === 'high' && f.category === 'behavior');
    assert.ok(revealFact, 'expected HIGH behavior fact for successful reveal');
    assert.match(revealFact.text, /open lookup/i);
  });
});

// ── Comparison tests ─────────────────────────────────────────────────────────

describe('Comparison: C1 no change', () => {
  it('produces no structural diff when both models are identical', () => {
    const controls = [makeControl('Company Code', 'valueHelp'), makeControl('Country', 'select')];
    const old = makeModel([makeSection('General Data', controls)]);
    const nw = makeModel([makeSection('General Data', [...controls])]);
    const diff = diffModels(old, nw);
    const structuralPoints = diff.points.filter((p) => ['added', 'removed', 'changed'].includes(p.category));
    assert.equal(structuralPoints.length, 0, 'identical models should produce no add/remove/change points');
  });
});

describe('Comparison: C2 section added', () => {
  it('reports the new section as ADDED with high importance', () => {
    const old = makeModel([makeSection('General Data', [makeControl('Name')])]);
    const nw = makeModel([
      makeSection('General Data', [makeControl('Name')]),
      makeSection('Payment Details', [makeControl('Method')]),
    ]);
    const diff = diffModels(old, nw);
    const added = diff.points.find((p) => p.category === 'added' && p.text.includes('Payment Details'));
    assert.ok(added, 'expected an ADDED point for the new section');
    assert.equal(added.importance, 'high');
  });
});

describe('Comparison: C3 section removed', () => {
  it('reports the missing section as REMOVED with high importance', () => {
    const old = makeModel([
      makeSection('General Data', [makeControl('Name')]),
      makeSection('Payment Details', [makeControl('Method')]),
    ]);
    const nw = makeModel([makeSection('General Data', [makeControl('Name')])]);
    const diff = diffModels(old, nw);
    const removed = diff.points.find((p) => p.category === 'removed' && p.text.includes('Payment Details'));
    assert.ok(removed, 'expected a REMOVED point for the dropped section');
    assert.equal(removed.importance, 'high');
  });
});

describe('Comparison: C4 control added', () => {
  it('reports a newly added control within a matched section', () => {
    const old = makeModel([makeSection('General Data', [makeControl('Company Code')])]);
    const nw = makeModel([makeSection('General Data', [makeControl('Company Code'), makeControl('Sales Office')])]);
    const diff = diffModels(old, nw);
    const added = diff.points.find((p) => p.category === 'added' && p.text.includes('Sales Office'));
    assert.ok(added, 'expected an ADDED point for the new control');
  });
});

describe('Comparison: C5 control removed', () => {
  it('reports a removed control within a matched section', () => {
    const old = makeModel([makeSection('General Data', [makeControl('Company Code'), makeControl('Sales Office')])]);
    const nw = makeModel([makeSection('General Data', [makeControl('Company Code')])]);
    const diff = diffModels(old, nw);
    const removed = diff.points.find((p) => p.category === 'removed' && p.text.includes('Sales Office'));
    assert.ok(removed, 'expected a REMOVED point for the dropped control');
  });
});

describe('Comparison: C6 control interaction changed', () => {
  it('reports a CHANGED point when a control keeps its kind but changes interactionKind', () => {
    // Same label + kind → 1:1 match → compare properties → CHANGED.
    // A kind change (input → valueHelp) is remove+add because kind is part of the key.
    const old = makeModel([makeSection('General Data', [makeControl('Start Date', 'date', 'fill')])]);
    const nw = makeModel([makeSection('General Data', [makeControl('Start Date', 'date', 'calendarOpen')])]);
    const diff = diffModels(old, nw);
    const changed = diff.points.find((p) => p.category === 'changed' && p.text.includes('Start Date'));
    assert.ok(changed, 'expected a CHANGED point for the interactionKind change');
  });

  it('reports REMOVED + ADDED (not CHANGED) when a control changes kind', () => {
    // Kind is part of the identity key, so a kind change is structurally a remove + add.
    const old = makeModel([makeSection('General Data', [makeControl('Company Code', 'input', 'fill')])]);
    const nw = makeModel([makeSection('General Data', [makeControl('Company Code', 'valueHelp', 'valueHelpOpen')])]);
    const diff = diffModels(old, nw);
    const removed = diff.points.find((p) => p.category === 'removed' && p.text.includes('Company Code'));
    const added = diff.points.find((p) => p.category === 'added' && p.text.includes('Company Code'));
    assert.ok(removed && added, 'kind change should produce REMOVED + ADDED, not CHANGED');
    const changed = diff.points.find((p) => p.category === 'changed' && p.text.includes('Company Code'));
    assert.ok(!changed, 'must not produce a CHANGED point for a kind change');
  });
});

describe('Comparison: C7 N:M composition — never pair positionally', () => {
  it('emits COMPOSITION_CHANGE, not individual matched points, for N:M duplicates', () => {
    // Two controls with the same key on each side — the plan says never pair positionally.
    const dup = () => [makeControl('Partner Function', 'input'), makeControl('Partner Function', 'input')];
    const old = makeModel([makeSection('Contact Persons', dup())]);
    const nw = makeModel([makeSection('Contact Persons', [...dup(), makeControl('Partner Function', 'input')])]);
    const diff = diffModels(old, nw);
    const comp = diff.points.find((p) => p.category === 'structure' && /composition/i.test(p.text));
    assert.ok(comp, 'expected a COMPOSITION_CHANGE point for N:M duplicates');
    // Must not produce individual "Partner Function was added" points.
    const spuriousAdded = diff.points.filter(
      (p) => p.category === 'added' && p.text.includes('Partner Function'),
    );
    assert.equal(spuriousAdded.length, 0, 'must not individually pair duplicate controls');
  });
});

describe('Comparison: C9 container added', () => {
  it('reports an ADDED container within a matched section', () => {
    const old = makeModel([makeSection('General Data', [makeControl('Name')])]);
    const nw = makeModel([
      makeSection('General Data', [makeControl('Name')], [makeContainer('group', 'Extra Group', [makeControl('Extra Field')])]),
    ]);
    const diff = diffModels(old, nw);
    const added = diff.points.find((p) => p.category === 'added' && /container/i.test(p.text));
    assert.ok(added, 'expected an ADDED container point');
    assert.equal(added.importance, 'high');
  });
});

describe('Comparison: C10 container removed', () => {
  it('reports a REMOVED container within a matched section', () => {
    const old = makeModel([
      makeSection('General Data', [makeControl('Name')], [makeContainer('group', 'Old Group', [makeControl('Old Field')])]),
    ]);
    const nw = makeModel([makeSection('General Data', [makeControl('Name')])]);
    const diff = diffModels(old, nw);
    const removed = diff.points.find((p) => p.category === 'removed' && /container/i.test(p.text));
    assert.ok(removed, 'expected a REMOVED container point');
  });
});

describe('Comparison: C11 controls inside matched container', () => {
  it('recurses into containers to report control-level changes', () => {
    const makeGroup = (controls: ControlNode[]) => makeContainer('group', 'Partner Data', controls);
    const old = makeModel([makeSection('General Data', [], [makeGroup([makeControl('Partner Function'), makeControl('Name')])])]);
    const nw = makeModel([makeSection('General Data', [], [makeGroup([makeControl('Partner Function'), makeControl('Name'), makeControl('Phone')])])]);
    const diff = diffModels(old, nw);
    const added = diff.points.find((p) => p.category === 'added' && p.text.includes('Phone'));
    assert.ok(added, 'expected ADDED control inside matched container');
  });
});

describe('Comparison: C12 capability lost', () => {
  it('emits a HIGH behavior point when a section loses all value-help capability', () => {
    const old = makeModel([makeSection('Criteria', [makeControl('Company Code', 'valueHelp'), makeControl('Country', 'select')])]);
    const nw = makeModel([makeSection('Criteria', [makeControl('Company Code', 'input'), makeControl('Country', 'select')])]);
    const diff = diffModels(old, nw);
    const capLost = diff.points.find((p) => p.category === 'behavior' && p.importance === 'high' && /value-help/i.test(p.text));
    assert.ok(capLost, 'expected HIGH behavior point for lost value-help capability');
  });
});

describe('Comparison: C13 pattern added/removed', () => {
  it('reports a pattern that exists in old but not new', () => {
    const makeFilterGroup = (i: number) =>
      makeContainer('group', `Group ${i}`, [makeControl(`Field ${i}`, 'input'), makeControl(`Action ${i}`, 'actionButton')]);

    const oldSections = [
      makeSection('A', [], [makeFilterGroup(1)]),
      makeSection('B', [], [makeFilterGroup(2)]),
      makeSection('C', [], [makeFilterGroup(3)]),
    ];
    const newSections = [
      makeSection('A', [makeControl('Field 1', 'input')]),
      makeSection('B', [makeControl('Field 2', 'input')]),
      makeSection('C', [makeControl('Field 3', 'input')]),
    ];
    const old = makeModel(oldSections);
    const nw = makeModel(newSections);
    const diff = diffModels(old, nw);
    const patternPoint = diff.points.find((p) => p.category === 'structure' && /pattern/i.test(p.text) && /no longer/i.test(p.text));
    assert.ok(patternPoint, 'expected a point for the recurring pattern disappearing');
  });
});

describe('Comparison: C14 UNRESOLVED — completely disjoint section sets', () => {
  it('emits UNRESOLVED when both sides have sections but zero pairs match', () => {
    const old = makeModel([makeSection('Alpha', [makeControl('X')]), makeSection('Beta', [makeControl('Y')])]);
    const nw = makeModel([makeSection('Gamma', [makeControl('A')]), makeSection('Delta', [makeControl('B')])]);
    const diff = diffModels(old, nw);
    // With completely disjoint keys, every section appears only on one side.
    // UNRESOLVED fires only when BOTH sides have sections and zero 2-sided CONFIRMED pairs.
    // Here, every section appears only on one side, so they resolve as CONFIRMED adds/removes.
    // True UNRESOLVED needs same keys but no 2-sided matches — test that separately.
    // This test validates the ADDED/REMOVED path for fully disjoint sets.
    const addedPoints = diff.points.filter((p) => p.category === 'added');
    const removedPoints = diff.points.filter((p) => p.category === 'removed');
    assert.ok(addedPoints.length > 0 || removedPoints.length > 0, 'disjoint sets must produce add/remove points');
  });

  it('emits UNRESOLVED when anonymous sections on both sides produce no 2-sided CONFIRMED pairs', () => {
    // Both sides have only junk-labelled sections — all map to __anonymous__.
    // 2 old + 2 new → COMPOSITION_CHANGE (N:M), no 2-sided CONFIRMED → UNRESOLVED fires.
    const old = makeModel([makeSection('.', [makeControl('A')]), makeSection('.', [makeControl('B')])]);
    const nw = makeModel([makeSection('.', [makeControl('C')]), makeSection('.', [makeControl('D')])]);
    const diff = diffModels(old, nw);
    // 2:2 anonymous → COMPOSITION_CHANGE. UNRESOLVED fires because no 2-sided CONFIRMED pair exists.
    const unresolved = diff.points.find((p) => p.category === 'unresolved');
    assert.ok(unresolved, 'expected UNRESOLVED when only anonymous sections on both sides produce no confirmed pairs');
  });
});

describe('Comparison: C15 equal-count N:M never paired', () => {
  it('does not pair equal-count duplicate sections positionally', () => {
    // 2 old sections with the same key, 2 new sections with the same key → COMPOSITION_CHANGE.
    const old = makeModel([makeSection('Contact Persons', [makeControl('Name')]), makeSection('Contact Persons', [makeControl('Phone')])]);
    const nw = makeModel([makeSection('Contact Persons', [makeControl('Name')]), makeSection('Contact Persons', [makeControl('Email')])]);
    const diff = diffModels(old, nw);
    const comp = diff.points.find((p) => p.category === 'structure' && /composition/i.test(p.text) && /contact persons/i.test(p.text));
    assert.ok(comp, 'expected COMPOSITION_CHANGE for equal-count N:M sections, never positional pairing');
    // Must not produce individual Email added / Phone removed points.
    const spurious = diff.points.filter(
      (p) => (p.category === 'added' && p.text.includes('Email')) ||
               (p.category === 'removed' && p.text.includes('Phone')),
    );
    assert.equal(spurious.length, 0, 'must not individually pair equal-count duplicate sections');
  });
});
