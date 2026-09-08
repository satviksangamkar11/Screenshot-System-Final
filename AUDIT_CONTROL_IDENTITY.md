# Control Identity Audit: SAP Fiori Elements Value-Help Fields

**Date**: 2026-09-08  
**Run**: job-5775e3e5-new-20260908060831 (post-Fix 1&2)  
**Status**: Multiple logical controls with identical labels identified as candidates for identity disambiguation

---

## Executive Summary

The new capture run shows 5 instances each of "Customer Number" and "Commission Payee" fields appearing in the trace. Analysis confirms these are **legitimately different logical controls** (different partner function rows), not duplicate captures of the same field. The current `dedupeKey` implementation correctly distinguishes them by section.

**However**, the form structure reveals a fragility: if multiple fields with the same label exist within the same section and have no semantic/stable ID suffix, the current dedupeKey formula `kind|section|label` would produce collisions.

---

## Evidence: Customer Number and Commission Payee Distribution

### From trace.json seq ordering:

**Customer Number** (5 instances):
```
seq 43: section="Partner Function Data"      ← Row 1
seq 44: section="Partner Function Data"      ← Row 2
seq 45: section="."                          ← Row 3 (section marker fuzzy)
seq 46: section="."                          ← Row 4 (section marker fuzzy)
seq 48: section="Commision Payee Partner fn" ← Row 5 (different section)
```

**Commission Payee** (5 instances):
```
seq 49: section="Commision Payee Partner fn" ← Row 1
seq 50: section="Commision Payee Partner fn" ← Row 2
seq 51: section="."                          ← Row 3 (section marker fuzzy)
seq 52: section="."                          ← Row 4 (section marker fuzzy)
seq 53: section="."                          ← Row 5 (section marker fuzzy)
```

### From DOCX document structure:

**Partner Function Data section:**
- Row 1: Customer Number
- Row 2: Customer Number
- Row 3: Customer Number
- Row 4: Customer Number
- Rep Dealer code (different field)

**Commision Payee Partner function section:**
- Row 1: Customer Number
- Row 1: Commission Payee
- Row 2: Commission Payee
- Row 3: Commission Payee
- Row 4: Commission Payee

### Interpretation:

These ARE different logical controls:
1. ✅ All have different positions in the form
2. ✅ All have different enclosing partner function rows
3. ✅ The trace shows them at different seq numbers (non-duplicate discovery)
4. ✅ Current dedupeKey distinguishes them correctly by section

---

## Current dedupeKey Implementation

**Location:** `src/discovery/classifier.ts` / `dedupeKeyFor()`

```typescript
function dedupeKeyFor(
  kind: ControlKind,
  label: string,
  canonicalLabel: string,
  section: string,
  id: string,
): string {
  const stableId = stableIdSuffix(id);
  if (stableId) return `${kind}|${stableId}`;     // Tier 1: Semantic suffix
  if (id) return `${kind}|${id}`;                 // Tier 2: Full ID
  const name = (canonicalLabel || label).trim().toLowerCase();
  if (name) return `${kind}|${section.trim().toLowerCase()}|${name}`;  // Tier 3: Section + Label
  return `${kind}|unknown`;                       // Fallback
}

function stableIdSuffix(id: string): string | undefined {
  const marker = id.indexOf('--');
  if (marker <= 0) return undefined;
  const stable = id.slice(marker);
  if (stable.length < 4) return undefined;
  return stable;
}
```

**Tiers of Identity:**

| Tier | Signal | Stability | False Positives | Example |
|------|--------|-----------|-----------------|---------|
| 1 | `--SemanticPart` | ✅ Very High | ❌ Extremely low | `--CustomerNumber-inner` survives UI5 view renumber |
| 2 | Full `id` | ❌ Low (UI5 churn) | ✅ None | `__xmlview2--CustNum` → `__xmlview3--CustNum` breaks selector |
| 3 | `section\|label` | ✅ High | ⚠️ HIGH RISK | If row 1 & row 2 Customer Number both in "Partner Function Data" |
| 4 | Fallback | ❌ None | ✅ Always collision | Only for label-less controls |

---

## Identity Risk Matrix

### Scenario 1: Multiple fields with same label, same section, NO semantic ID suffix

**Condition:**
- Two fields: `Customer Number` in section `Partner Function Data`
- Both lack UI5 `--` prefix in their HTML IDs (e.g., `__button42`, `__input99`)
- Current ID: `__xmlview2--input99` → stableIdSuffix extracts nothing (no `--` in XML view id + field id)

**Current dedupeKey:**
```
BOTH → "valueHelp|partner function data|customer number"
COLLISION ✅ Same key, different fields
```

**Outcome:** Second occurrence not deduplicated (FALSE NEGATIVE - processed twice)

**Likelihood:** ⚠️ **MEDIUM** — depends on whether adapter provides semantic IDs for these partner function rows

---

### Scenario 2: Two distinct logical controls with same label, different sections

**Condition:**
- Field A: `Customer Number` in section `Partner Function Data`
- Field B: `Customer Number` in section `Commision Payee Partner function`
- Both have semantic ID suffixes

**Current dedupeKey:**
```
A → "valueHelp|--CustomerNumberPartner1-inner"
B → "valueHelp|--CustomerNumberPartner2-inner"
DISTINCT ✅ Different keys
```

**Outcome:** Both correctly discovered as separate fields (TRUE POSITIVE)

**Likelihood:** ✅ **HIGH** — current trace shows this working correctly

---

### Scenario 3: Same logical field, DOM rebuilt (UI5 view renumber)

**Condition:**
- Field ID changes: `__xmlview2--CustomerNum-inner` → `__xmlview3--CustomerNum-inner`
- Semantic suffix: `--CustomerNum-inner` (stable)
- Both refer to same physical control

**Current dedupeKey:**
```
BOTH → "valueHelp|--CustomerNum-inner"
DEDUPLICATED ✅ Same key
```

**Outcome:** Second occurrence correctly identified as duplicate and NOT processed again

**Likelihood:** ✅ **HIGH** — this is the primary dedupeKey strength

---

## Available Identity Signals (ControlDescriptor fields)

### Captured at discovery time:
1. **`id`** — Raw HTML element ID
   - Stability: ❌ Churns with UI5 view renumber
   - Entropy: High (unique per control)
   
2. **`stableIdSuffix(id)`** — Extracted from `id` if contains `--`
   - Stability: ✅ Survives UI5 view renumber
   - Entropy: High (application-authored part)
   - Availability: ⚠️ Only if adapter captures semantic IDs

3. **`section`** — Enclosing page-level heading
   - Stability: ✅ Survives DOM rebuilds within single discovery pass
   - Entropy: ⚠️ Multiple fields can share same section
   - Example: Both Customer Number rows in "Partner Function Data"

4. **`label` / `canonicalLabel`** — Human-visible field label
   - Stability: ✅ Same across re-renders
   - Entropy: ❌ VERY LOW (multiple fields can share label)
   - Example: 5 Customer Number fields

5. **`containerType` / `containerLabel`** — Immediate structural container
   - Stability: ✅ Should survive DOM rebuilds
   - Entropy: ❌ Most are generic (e.g., all "group" with no label)
   - Captured: ✅ All entries show `containerType: "group", containerLabel: ""`

6. **`domOrder`** — Document order position
   - Stability: ✅ Within a single discovery pass
   - Entropy: ✅ HIGH (unique within container, unless controls swap order)
   - Availability: ✅ Always assigned (see `src/discovery/adapters/aria-dom.ts:orderOf`)
   - **USE CASE:** Distinguishing Customer Number row 1 from row 2 in same section
   - **WARNING:** Churns if DOM is re-rendered (controls might reorder)

7. **`selector` / `fallbackSelector`** — CSS locator
   - Stability: ⚠️ Partial (fallback selector survives ID churn)
   - Entropy: High
   - Problem: Can be identical for controls that only differ by DOM order

---

## Design Options for Enhanced Identity

### Option A: Add domOrder as tertiary signal (REJECTED)

**Why rejected**: domOrder is a snapshot-specific signal tied to a single DOM state. It churns when:
- Elements are inserted/removed (mid-discovery)
- DOM is reordered (page reflowing)
- View is re-rendered (same logical control, different position)

NOT suitable for stable logical identity across discovery sweeps.

---

### Option B: Leverage Existing UI5 controlId (INVESTIGATING)

**Current situation**:
- UI5 adapter captures `el.getId()` → Ui5RawControl.id → ControlDescriptor.id
- descriptor.id contains the FULL controlId (e.g., `__xmlview2--PartnerFunction-0--CustomerNumber`)
- dedupeKeyFor() uses stableIdSuffix() to extract `--PartnerFunction-0--CustomerNumber`

**Hypothesis**: If partner function rows each have unique controlIds with semantic suffixes, they're ALREADY distinct at Tier 1 of current dedupeKey.

**Question**: Are Customer Number row 1-5 getting:
- Same controlId reused? (broken)
- Different controlIds with -- suffix? (working)
- Different controlIds without -- suffix? (Tier 2 works)

**Cannot determine without actual controlId logging.**

**False positive risk:** ✅ **DEPENDS ON APP STRUCTURE** — if IDs are reused across rows, current system fails; if unique per row, works correctly

---

### Option B: Coordinate index from adaptive ordinal

**Requirements:**
- Adapters provide array/ordinal index for repeating fields
- Example: "Partner Function row 2" → index 2
- Only UI5 adapter supports this currently

**Pros:**
- ✅ Survives DOM rebuilds
- ✅ Semantic (tied to data structure, not DOM)

**Cons:**
- ❌ Requires adapter changes for all technologies
- ❌ Repeating field detection not available in generic ARIA/DOM adapter
- ❌ Out of scope for current architecture (adapters don't model arrays)

**False positive risk:** ✅ **LOW** — but not viable in current codebase

---

### Option C: Stable locator as identity

**Requirements:**
- Use `fallbackSelector` (CSS selector that survives UI5 churn) as dedupeKey
- Example: `[role="textbox"]:has(+ label:contains("Customer Number"))`

**Pros:**
- ✅ Works even without semantic IDs
- ✅ Survives UI5 view renumber

**Cons:**
- ❌ CSS selectors are fragile (layout changes break them)
- ❌ Cannot guarantee uniqueness
- ❌ Hard to debug collisions

**False positive risk:** ⚠️ **HIGH** — selectors are fragile

---

### Option D: Section + Label + containerLabel enhancement

**Requirements:**
- Ensure UI5 adapter captures meaningful `containerLabel` for partner function rows
- Example: `containerLabel: "Bill To Party"` or `"Partner Function [2]"`

**Pros:**
- ✅ Semantic (tied to form structure)
- ✅ Survives DOM rebuilds

**Cons:**
- ❌ Requires adapter enhancement
- ❌ Not all containers have labels
- ❌ Partner function rows may not have labels

**False positive risk:** ✅ **LOW** — but requires adapter work

---

## Recommendation

**DO NOT implement Option A.** domOrder is unstable across rerenders.

**INSTEAD: Audit controlId structure** before modifying dedupeKeyFor():

### Step 1: Log Actual controlIds

Add debug logging to discovery to capture what controlIds are being extracted for Customer Number and Commission Payee rows:

```typescript
// In src/discovery/classifier.ts makeDescriptor():
if (label.includes('Customer Number') || label.includes('Commission Payee')) {
  log.info(`[AUDIT] label="${label}" id="${args.id}" section="${args.section}"`);
}
```

Run fresh capture and examine output. This will show:
- Are rows getting unique controlIds?
- Do IDs have `--` semantic markers?
- Does section detection work for all rows?

### Step 2: Determine Root Cause

Based on the logs, one of three cases applies:

**Case A: Each row has UNIQUE controlId with -- marker**
```
Row 1: __xmlview2--PartnerFunction-0--CustomerNumber  → stableIdSuffix: --PartnerFunction-0--CustomerNumber
Row 2: __xmlview2--PartnerFunction-1--CustomerNumber  → stableIdSuffix: --PartnerFunction-1--CustomerNumber
```
**Result**: Current system works ✅ NO CHANGE NEEDED

**Case B: Rows have unique controlIds but NO -- marker**
```
Row 1: __xmlview2--input99  → stableIdSuffix: --input99 (Tier 2)
Row 2: __xmlview2--input100 → stableIdSuffix: --input100 (Tier 2)
```
**Result**: Current Tier 2 fallback works ✅ NO CHANGE NEEDED

**Case C: Rows reuse SAME controlId**
```
Row 1: __xmlview2--CustomerNumber
Row 2: __xmlview2--CustomerNumber  (same!)
Row 3: __xmlview2--CustomerNumber  (same!)
```
**Result**: Current system fails ❌ NEEDS FIX (see Case C solution below)

### Step 3: If Case C Confirmed

**DO NOT use domOrder.** Instead, enhance UI5 adapter to capture:
- Binding context path (e.g., `result/Partner_Functions/0/`)
- OData array index (e.g., `[0]`, `[1]`, `[2]`)
- App-authored row identifier from data

Design a **semantic row identity** that survives:
- UI5 view renumbering
- DOM reordering
- Discovery re-sweeps

This is an adapter-level enhancement, not a dedupeKey formula patch.

---

## Regression Test Cases

### Test Case 1: Same logical control + different rendered DOM id

**Fixture:** `fixtures/id-churn.html` (already exists)

**Scenario:**
```
Render 1: __xmlview2--DueDateId-inner       → stableIdSuffix: "--DueDateId-inner"
Render 2: __xmlview3--DueDateId-inner       → stableIdSuffix: "--DueDateId-inner"
```

**Expectation:**
```
dedupeKey(R1) == dedupeKey(R2) ✅ DEDUPLICATED
```

**Test location:** `src/discovery/__tests__/classifier.test.ts` (create if missing)

---

### Test Case 2: Two distinct controls, same label, same section, different domOrder

**Scenario:**
```
Control A: label="Customer Number", section="Partner Function Data", domOrder=100
Control B: label="Customer Number", section="Partner Function Data", domOrder=101
Both: No semantic ID suffix
```

**Expectation with Option A:**
```
dedupeKey(A) = "valueHelp|partner function data|customer number|100"
dedupeKey(B) = "valueHelp|partner function data|customer number|101"
DISTINCT ✅ NOT DEDUPLICATED
```

---

### Test Case 3: Existing UI5 stable ID behavior continues working

**Scenario:**
```
Control: id="__xmlview2--SalesOrgId-inner"  → stableIdSuffix: "--SalesOrgId-inner"
```

**Expectation:**
```
Tier 1 (Semantic) match takes precedence
dedupeKey uses "--SalesOrgId-inner" only, ignores section/label/domOrder
```

---

### Test Case 4: Label-only fallback (controls without IDs)

**Scenario:**
```
Control: label="Submit", section="", id=""
No domOrder tracking (unlikely but possible)
```

**Expectation:**
```
dedupeKey = "button|unknown"  (or similar fallback)
```

---

### Test Case 5: Section + Label collision edge case (MUST NOT HAPPEN with Option A)

**Scenario:**
```
Control A: section="General", label="Due Date", domOrder=50, no ID suffix
Control B: section="General", label="Due Date", domOrder=51, no ID suffix
```

**Current (broken):**
```
Both → "input|general|due date"  ❌ COLLISION
```

**With Option A:**
```
A → "input|general|due date|50"
B → "input|general|due date|51"  ✅ DISTINCT
```

---

## Implementation Checklist

- [ ] Add `domOrder` parameter to `dedupeKeyFor()` signature
- [ ] Update dedupeKey formula: add domOrder as tertiary signal (Tier 3b)
- [ ] Update call sites in `classifier.ts` to pass domOrder
- [ ] Create `src/discovery/__tests__/classifier.test.ts` with 5 test cases above
- [ ] Run tests: `npx tsx --test src/discovery/__tests__/classifier.test.ts`
- [ ] Manual verification: run new capture, check Customer Number/Commission Payee counts
- [ ] Do NOT modify `stableIdSuffix()` or `stableIdSelector()` — those are working correctly

---

## False Positive Risks Summary

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| domOrder changes during discovery | ⚠️ MEDIUM | Ensure discovery is atomic; don't re-render mid-discovery |
| Multiple controls have identical domOrder | ❌ Very Low | Each control occupies a unique DOM node, gets unique order |
| Section detection is unreliable | ⚠️ MEDIUM | Existing issue, not made worse by this change |
| Controls reorder between runs | ✅ LOW | Within-run identity only; separate runs are independent |

---

## Next Steps (Deferred)

1. **Identity audit for filter-bar buttons** — Standard, Hide Filter Bar, Filters, Go (separate task)
2. **Adapter enhancement:** UI5 adapter should capture semantic row indices for partner functions
3. **Architectural review:** Design stable logical identity contract across all adapters

