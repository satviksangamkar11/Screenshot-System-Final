# UI5 Identity Trace: Adapter Boundary to Deduplication

**Analysis Date**: 2026-09-08  
**Subject**: Customer Number (5 instances) and Commission Payee (5 instances)

---

## Identity Information Flow

```
UI5 Registry (sap.ui.core.Element)
    ↓
controlId = el.getId()  [extracted by probe]
    ↓
Ui5RawControl.id = controlId
    ↓
makeDescriptor( { id: controlId, ... } )
    ↓
ControlDescriptor.id = controlId
    ↓
dedupeKeyFor(kind, label, canonicalLabel, section, id)
    ↓
stableIdSuffix(id)  [extracts -- marker portion]
    ↓
Tier 1 or Tier 2 or Tier 3 dedupeKey
```

---

## Critical Discovery: What the Current System Captures

From `src/discovery/classifier.ts:makeDescriptor()`:

```typescript
const descriptor: ControlDescriptor = {
  id: args.id,  // ← This is the UI5 controlId
  dedupeKey: dedupeKeyFor(args.kind, label, canonicalLabel, args.section, args.id),
  kind: args.kind,
  label,
  canonicalLabel,
  selector: args.selector,
  fallbackSelector: stableIdSelector(args.id),  // ← Also uses controlId
  domOrder: args.domOrder,
  required: args.required,
  isPoint: ...,
  section: args.section,
  containerType: args.containerType,
  containerLabel: args.containerLabel,
};
```

**Key insight**: The descriptor DOES contain the full `controlId` as the `id` field. BUT `dedupeKeyFor()` only looks at:
1. Tier 1: `stableIdSuffix(id)` — extracts `--` portion
2. Tier 2: Full `id` (if no `--` found)
3. Tier 3: `section|label` (if id is empty)

---

## Question 1: What is the UI5 controlId for Each Customer Number Row?

**From UI5 registry probe** (`src/discovery/adapters/ui5.ts`):

```typescript
controlId: safe(() => String(el.getId?.() ?? ''), ''),
```

**Possible patterns in SAP Fiori Elements**:

### Case A: Unique per Row (EXPECTED)
```
Row 1: __xmlview2--PartnerFunction-0--CustomerNumber
Row 2: __xmlview2--PartnerFunction-1--CustomerNumber
Row 3: __xmlview2--PartnerFunction-2--CustomerNumber
...
```
- stableIdSuffix would extract `--PartnerFunction-0--CustomerNumber`
- Each row gets **different stableIdSuffix**
- dedupeKey at Tier 1: DISTINCT ✅

### Case B: Generic/Auto-generated (RISKY)
```
Row 1: __xmlview2--input99
Row 2: __xmlview2--input100
Row 3: __xmlview2--input101
```
- stableIdSuffix would return undefined (4-char check: `--input99` = 9 chars ✓ passes)
- Actually `--input99` DOES pass the length check!
- dedupeKey at Tier 2: `valueHelp|--input99`, `valueHelp|--input100`, etc.
- DISTINCT at Tier 2 ✅

### Case C: Reused Across Rows (BROKEN)
```
Row 1: __xmlview2--CustomerNumber
Row 2: __xmlview2--CustomerNumber  (same!)
Row 3: __xmlview2--CustomerNumber  (same!)
```
- stableIdSuffix: `--CustomerNumber` (same for all)
- dedupeKey at Tier 1: ALL COLLISION ❌
- Would fall through to Tier 3: `valueHelp|partner function data|customer number`
- STILL COLLISION ❌

---

## Question 2: What is domId?

From `src/discovery/adapters/ui5.ts`:

```typescript
domId: dom?.id ?? '',
```

This is the HTML element's `id` attribute. For partner function rows:
- Might be empty (many UI5 controls don't set HTML ids)
- If present, might follow same pattern as controlId
- NOT used in dedupeKeyFor() — only as a claim-tracking mechanism

---

## Question 3: Are They the Same UI5 Registry Object/controlId?

**From the dedupeKeyFor comments** (`src/discovery/classifier.ts`):

> "A UI5 id is unique across the whole application at any instant by construction (that is exactly what `Element.registry` indexes on), so two discoveries reporting the same id are always the same control, regardless of which container"

**Implication**: If Customer Number row 1 and row 2 report DIFFERENT controlIds, they are **definitely** different logical controls. If they report the SAME controlId, they are the **same** logical control appearing twice (problematic).

---

## Question 4: Stable Row/Context Identity

**How UI5 handles repeating rows**:

In SAP Fiori Elements with OData v2/v4 bindings:
- Partner function rows typically bind to an array (e.g., `result.Partner_Functions`)
- Each row is numbered or indexed: `[0]`, `[1]`, `[2]`, etc.
- Controls inside the row template get IDs like `__xmlview2--PartnerFunctionRow--[0]--CustomerNumber`
- OR with simpler binding: `__xmlview2--PartnerFunctionRow0--CustomerNumber`

**The stable signal**: The row INDEX or BINDING CONTEXT is stable. But:
- ❌ This info is NOT captured in Ui5RawControl
- ❌ This info is NOT available in ControlDescriptor
- ❌ This info is NOT available to dedupeKeyFor()

**What IS available**: The controlId itself contains the binding context if the app structures IDs properly.

---

## Question 5: Which Fields Survive UI5 Rerender?

**Survives** (stable across re-render of same element):
- ✅ controlId (`el.getId()`) — unless the element is replaced
- ✅ HTML structure — unless intentionally restructured
- ✅ Binding context — unless data changes

**Does NOT survive** (churns on rerender):
- ❌ domOrder — elements may reorder
- ❌ HTML `id` attribute — if regenerated
- ❌ Auto-generated IDs like `__button42` — UI5 view counter increments

**The key distinction**:
- If row 1 is "the element bound to Partner[0]", that's **stable across rerenders**
- If row 1 gets `__button42` that changes to `__button57` on rerender, that's **unstable**

---

## Question 6: Which Fields Distinguish Legitimate Duplicate Labels?

Current ControlDescriptor fields available to distinguish "Customer Number #1" from "Customer Number #2":

| Field | Unique? | Stable? | Available? |
|-------|---------|---------|-----------|
| `id` (controlId) | ✅ YES (if rows have unique IDs) | ✅ YES (if semantic) | ✅ YES |
| `section` | ❌ NO (both "Partner Function Data") | ✅ YES | ✅ YES |
| `label` | ❌ NO (both "Customer Number") | ✅ YES | ✅ YES |
| `domOrder` | ✅ YES (row 1 vs row 2) | ❌ NO (can reorder) | ✅ YES |
| `containerLabel` | ❌ EMPTY (no label on group) | ✅ YES | ✅ YES |
| Binding context index | ✅ YES (row [0] vs [1]) | ✅ YES | ❌ NOT CAPTURED |
| Row path (app-authored) | ✅ YES | ✅ YES | ❌ ONLY in controlId suffix |

**Verdict**: Only `id` (controlId) and `domOrder` are unique. Only `id` is guaranteed stable. But `id` uniqueness depends on whether the app gives each row a distinct controlId.

---

## Question 7: Does the Descriptor Lose Information Before dedupeKeyFor()?

**Answer**: NO, information is preserved in the descriptor:

```typescript
ControlDescriptor {
  id: "actual controlId from UI5",      // ← FULL controlId is here
  dedupeKey: "computed from id",        // ← Only Tier 1 extracted
  // ... other fields ...
}
```

However, **dedupeKeyFor() only uses**:
- `stableIdSuffix(id)` — only if `--` marker present
- Full `id` — if no `--` marker
- NEVER uses binding context or row index from controlId

---

## The Root Problem: Unknown controlId Structure

The core issue is: **We don't know what controlIds the SAP Fiori app is actually generating for partner function rows.**

If they follow Case A (unique per row with semantic suffix):
- Current system works ✅
- No change needed

If they follow Case B (auto-generated but unique):
- Current Tier 2 should work ✅
- No change needed

If they follow Case C (reused):
- Current system fails ❌
- Tier 3 collision occurs

**Without seeing the actual controlIds in the trace, we cannot determine which case applies.**

---

## Hypothesis Based on Trace Evidence

Looking at the new run (job-5775e3e5):
- 181 controls processed (vs 366 old)
- 51% reduction in reprocessing
- NO cascade of Standard/Hide Filter Bar after failed selections

**If Case C were happening** (controlId reused), we'd see:
- Customer Number getting deduplicated by current system
- Should appear only 1-2 times, not 5

**Since we see 5 instances and NO crashes**, suggests:
- ✅ Likely Case A or B: Each row HAS a unique controlId
- The 5 instances represent 5 legitimate different controls
- Current deduplication is working correctly for these controls

**BUT**: The section field shows "." for some entries, indicating section detection failed. This is a separate data-quality issue, not an identity issue.

---

## Recommendation

**Before modifying dedupeKeyFor():**

1. **Log the actual controlIds** for Customer Number rows during discovery
   - Add debug logging to `makeDescriptor()`:
   ```typescript
   if (label.includes('Customer Number')) {
     console.log(`Customer Number: id=${args.id}, section=${args.section}`);
   }
   ```

2. **Verify section detection** — why does it return "." for some rows?
   - Check `sectionOf()` function in UI5 adapter

3. **Confirm row identity** —are the 5 instances really 5 different controls?
   - Check UI5 registry: are there 5 distinct controlIds?
   - Or are there fewer, with some being re-discovered?

4. **Only then modify dedupeKey** — based on actual evidence, not speculation

---

## Architectural Insight

**The current system's assumption**:
> "UI5 gives each control a unique ID that either contains a semantic suffix (--) or is unique enough that full-ID matching works (Tier 2)."

**The risk**:
> "Some controls get auto-generated IDs without semantic meaning, and Tier 2 collisions can occur with legitimate different controls if their IDs happen to be missing from discovery sweeps."

**The real solution** (deferred task):
> "Enhance UI5 adapter to capture binding context indices or row paths from modelPath/sPath, providing a semantic row identity separate from controlId churn."

---

## What's NOT the Problem

❌ domOrder — Not suitable for production identity (can change)  
❌ Label-only matching — Already proven to fail (5 Customer Numbers)  
❌ Section + label — Already in use, works when controlIds are stable  
❌ Regex heuristics on controlId — Fragile, not portable  

---

## What MIGHT Be the Real Issue

✅ **Section detection failure** — some rows reporting section="." instead of actual section  
✅ **Binding context invisible** — app uses array binding but adapter doesn't see it  
✅ **ID reuse in repeating controls** — older UI5 patterns reuse control IDs across rows

---

## Action: Audit Request

To conclusively answer these questions, capture logs with this diff:

```diff
if (c.domId) claimedDomIds.add(c.domId);
found++;

+ if ((c.label.includes('Customer Number') || c.label.includes('Commission Payee'))) {
+   log.info(`[PartnerFn] id="${c.id}" label="${c.label}" section="${c.section}" domId="${c.domId}"`);
+ }

const kind = adapter.classify(c);
```

Run a fresh capture and examine logs for the 5 Customer Number and 5 Commission Payee entries. The IDs will show:
- Whether each row has unique controlId
- Whether section detection works
- Whether domId follows a pattern

**Only then** can we design the correct identity solution.

