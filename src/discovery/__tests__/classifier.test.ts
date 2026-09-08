/**
 * Identity contract tests for control deduplication.
 *
 * These tests verify that `dedupeKeyFor()` correctly identifies:
 * 1. The same logical control across DOM rebuilds (UI5 view renumber)
 * 2. Different logical controls with identical labels in the same section
 * 3. Existing stable ID behavior continues to work
 *
 * Run: npx tsx --test src/discovery/__tests__/classifier.test.ts
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

/**
 * Minimal reproduction of dedupeKeyFor() for testing.
 *
 * This is the CURRENT implementation. After Option A is implemented,
 * the production version will also accept domOrder.
 */
function dedupeKeyForCurrent(
  kind: string,
  label: string,
  canonicalLabel: string,
  section: string,
  id: string,
): string {
  const stableId = stableIdSuffix(id);
  if (stableId) return `${kind}|${stableId}`;

  if (id) return `${kind}|${id}`;

  const name = (canonicalLabel || label).trim().toLowerCase();
  if (name) return `${kind}|${section.trim().toLowerCase()}|${name}`;
  return `${kind}|unknown`;
}

/**
 * PROPOSED enhancement: include domOrder as tertiary signal.
 * This will become the production version after Option A is implemented.
 *
 * NEW TIER ORDER:
 * 1. Semantic suffix (--StablePart) — survives UI5 renumber
 * 2. Section + Label + domOrder — distinguishes same-label rows
 * 3. Section + Label — fallback for stable fields without domOrder
 * 4. Full ID — last resort for non-routable controls
 * 5. Fallback — unknown
 */
function dedupeKeyForEnhanced(
  kind: string,
  label: string,
  canonicalLabel: string,
  section: string,
  id: string,
  domOrder?: number,
): string {
  const stableId = stableIdSuffix(id);
  if (stableId) return `${kind}|${stableId}`;

  const name = (canonicalLabel || label).trim().toLowerCase();

  // NEW: Section + Label + domOrder takes precedence over bare ID
  if (name && domOrder !== undefined) {
    return `${kind}|${section.trim().toLowerCase()}|${name}|${domOrder}`;
  }

  // Section + Label fallback
  if (name) return `${kind}|${section.trim().toLowerCase()}|${name}`;

  // Only use bare ID if there's no semantic label
  if (id) return `${kind}|${id}`;

  return `${kind}|unknown`;
}

function stableIdSuffix(id: string): string | undefined {
  const marker = id.indexOf('--');
  if (marker <= 0) return undefined;

  const stable = id.slice(marker);
  if (stable.length < 4) return undefined;

  return stable;
}

describe('dedupeKeyFor - Current Implementation', () => {
  it('Test Case 1: Same logical control + different rendered DOM id (UI5 view renumber)', () => {
    // Fixture: id-churn.html scenario
    // The `--DueDateId-inner` part is stable; the __xmlviewN prefix churns

    const render1 = dedupeKeyForCurrent(
      'input',
      'Due Date',
      'Due Date',
      'General',
      '__xmlview2--DueDateId-inner',
    );

    const render2 = dedupeKeyForCurrent(
      'input',
      'Due Date',
      'Due Date',
      'General',
      '__xmlview3--DueDateId-inner',
    );

    assert.equal(
      render1,
      render2,
      'Same field across view renumbers should produce same dedupeKey',
    );
    assert.match(render1, /--DueDateId-inner/, 'Should extract and use stable suffix');
  });

  it('Test Case 3: Existing UI5 stable ID behavior continues working', () => {
    // Real application-authored IDs with -- prefix should always use Tier 1

    const key1 = dedupeKeyForCurrent(
      'valueHelp',
      'Sales Organization',
      'Sales Organization',
      'Organizational Data',
      '__xmlview2--SalesOrgId-inner',
    );

    const key2 = dedupeKeyForCurrent(
      'valueHelp',
      'Sales Organization',
      'Sales Organization',
      'Organizational Data',
      '__xmlview2--SalesOrgId-inner',
    );

    assert.equal(key1, key2, 'Identical application IDs should produce same key');
    assert.equal(
      key1,
      'valueHelp|--SalesOrgId-inner',
      'Should use Tier 1: semantic suffix only',
    );
  });

  it('Test Case 4: Label-only fallback for controls without IDs', () => {
    // Some generated controls have no ID (e.g., dynamically created elements)
    const key = dedupeKeyForCurrent('button', 'Submit', 'Submit', '', '');

    assert.match(key, /^button\|/, 'Should start with kind');
    assert.match(key, /submit/, 'Should include label in fallback');
  });

  it('Test Case 5 (Current, BROKEN): Section + Label collision edge case', () => {
    // This is the CURRENT BROKEN behavior that Option A will fix
    // Two Customer Number fields in same section with no semantic ID suffix
    // The CURRENT implementation uses Tier 2 (full ID) when IDs differ, so it doesn't
    // collide at section+label. But if the HTML IDs were somehow identical
    // (e.g., DOM cloning or framework re-use), OR if we ignore Tier 2 and look at Tier 3,
    // they would collide.
    //
    // To demonstrate the REAL collision that Option A fixes, we imagine a scenario
    // where the framework doesn't give these fields unique IDs at all (empty ID).

    const controlA = dedupeKeyForCurrent(
      'valueHelp',
      'Customer Number',
      'Customer Number',
      'Partner Function Data',
      '', // No ID at all — both controls have empty IDs
    );

    const controlB = dedupeKeyForCurrent(
      'valueHelp',
      'Customer Number',
      'Customer Number',
      'Partner Function Data',
      '', // Same: no ID
    );

    // CURRENT BEHAVIOR (BROKEN):
    assert.equal(
      controlA,
      controlB,
      'Multiple same-label fields in same section with no ID produce identical keys',
    );
    assert.equal(
      controlA,
      'valueHelp|partner function data|customer number',
      'Falls back to Tier 3 (section + label)',
    );

    // NOTE: These SHOULD be different after Option A implementation via domOrder.
    // See Test Case 5 in the enhanced version below.
  });
});

describe('dedupeKeyFor - Enhanced Implementation (Option A)', () => {
  it('Test Case 1 (Enhanced): Same logical control + different rendered DOM id (UI5 view renumber)', () => {
    // Enhanced version also handles this case correctly (Tier 1 still works)

    const render1 = dedupeKeyForEnhanced(
      'input',
      'Due Date',
      'Due Date',
      'General',
      '__xmlview2--DueDateId-inner',
      42, // domOrder doesn't matter because stableIdSuffix wins
    );

    const render2 = dedupeKeyForEnhanced(
      'input',
      'Due Date',
      'Due Date',
      'General',
      '__xmlview3--DueDateId-inner',
      42, // Same domOrder in same discovery pass
    );

    assert.equal(
      render1,
      render2,
      'Tier 1 (semantic suffix) takes precedence over domOrder',
    );
  });

  it('Test Case 2 (Enhanced): Two distinct controls, same label, same section, different domOrder', () => {
    // This is the NEW capability added by Option A
    // Customer Number row 1 vs row 2 in "Partner Function Data"

    const customerNumberRow1 = dedupeKeyForEnhanced(
      'valueHelp',
      'Customer Number',
      'Customer Number',
      'Partner Function Data',
      '__input99', // No -- marker, so stableIdSuffix returns undefined
      100, // domOrder: row 1
    );

    const customerNumberRow2 = dedupeKeyForEnhanced(
      'valueHelp',
      'Customer Number',
      'Customer Number',
      'Partner Function Data',
      '__input100', // No -- marker, so stableIdSuffix returns undefined
      101, // domOrder: row 2
    );

    assert.notEqual(
      customerNumberRow1,
      customerNumberRow2,
      'Different domOrder creates different keys for same-label fields',
    );
    assert.match(customerNumberRow1, /\|100$/, 'Row 1 key ends with domOrder=100');
    assert.match(customerNumberRow2, /\|101$/, 'Row 2 key ends with domOrder=101');
  });

  it('Test Case 3 (Enhanced): Existing UI5 stable ID behavior continues working', () => {
    // Tier 1 still wins, domOrder is not used

    const key = dedupeKeyForEnhanced(
      'valueHelp',
      'Sales Organization',
      'Sales Organization',
      'Organizational Data',
      '__xmlview2--SalesOrgId-inner',
      42, // domOrder is provided but not used
    );

    assert.equal(
      key,
      'valueHelp|--SalesOrgId-inner',
      'Semantic suffix takes precedence; domOrder is ignored',
    );
  });

  it('Test Case 4 (Enhanced): Label-only fallback for controls without IDs or domOrder', () => {
    const key = dedupeKeyForEnhanced(
      'button',
      'Submit',
      'Submit',
      '', // no section
      '', // no id
      undefined, // no domOrder
    );

    assert.match(key, /submit/, 'Falls back to label-based key');
    assert.equal(key.includes('undefined'), false, 'Undefined domOrder does not appear in key');
  });

  it('Test Case 5 (Enhanced, FIXED): Section + Label collision fixed with domOrder', () => {
    // After Option A, these should be distinct

    const controlA = dedupeKeyForEnhanced(
      'valueHelp',
      'Customer Number',
      'Customer Number',
      'Partner Function Data',
      '__input99', // No -- marker
      500, // Row 1's domOrder
    );

    const controlB = dedupeKeyForEnhanced(
      'valueHelp',
      'Customer Number',
      'Customer Number',
      'Partner Function Data',
      '__input100', // No -- marker
      501, // Row 2's domOrder
    );

    assert.notEqual(controlA, controlB, 'Different domOrder creates distinct keys');
    assert.match(controlA, /partner function data.*\|500$/, 'Includes section and domOrder');
    assert.match(controlB, /partner function data.*\|501$/, 'Includes section and domOrder');
  });

  it('Test Case 6 (Enhanced): Different sections still distinct even with same label and domOrder', () => {
    // Customer Number in "Partner Function Data" vs "Commision Payee Partner function"
    // are legitimately different controls

    const cpd = dedupeKeyForEnhanced(
      'valueHelp',
      'Customer Number',
      'Customer Number',
      'Partner Function Data',
      '__input99', // No -- marker
      42,
    );

    const cpf = dedupeKeyForEnhanced(
      'valueHelp',
      'Customer Number',
      'Customer Number',
      'Commision Payee Partner function',
      '__input99', // Same full ID (theoretical, both without -- marker)
      42, // Same domOrder (theoretical)
    );

    assert.notEqual(cpd, cpf, 'Different sections create different keys');
    assert.match(cpd, /partner function data/, 'CPD key includes its section');
    assert.match(cpf, /commision payee partner function/, 'CPF key includes its section');
  });
});

describe('stableIdSuffix extraction', () => {
  it('Extracts suffix from UI5 view-prefixed IDs', () => {
    const result = stableIdSuffix('__xmlview2--DueDateId-inner');
    assert.equal(result, '--DueDateId-inner', 'Should extract from -- onward');
  });

  it('Returns undefined for IDs without -- marker', () => {
    const result = stableIdSuffix('__button42');
    assert.equal(result, undefined, 'Should return undefined for no -- marker');
  });

  it('Returns undefined for empty or very short suffixes', () => {
    assert.equal(stableIdSuffix('a--ab'), '--ab', 'Suffix exactly 4 chars is accepted');
    assert.equal(stableIdSuffix('x--y'), undefined, 'Suffix too short (3 chars < 4)');
    assert.equal(stableIdSuffix(''), undefined, 'Empty string');
  });

  it('Handles multiple -- markers (takes first)', () => {
    // Edge case: if somehow there are multiple --, take the first
    const result = stableIdSuffix('__xmlview2--field--withDashes');
    assert.equal(result, '--field--withDashes', 'Should include all dashes after first --');
  });
});
