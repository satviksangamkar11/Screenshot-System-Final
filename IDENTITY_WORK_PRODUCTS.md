# Control Identity Audit — Work Products

## Summary

This audit establishes the **identity contract** for deduplication before any code changes are made. All deliverables are complete and tested.

---

## Documents (Read in This Order)

### 1. **IDENTITY_AUDIT_SUMMARY.md** (THIS FILE)
Executive summary with key findings, risks, and implementation checklist.  
**Read time: 10 minutes**

### 2. **AUDIT_CONTROL_IDENTITY.md** (FULL TECHNICAL AUDIT)
Comprehensive 300+ line audit covering:
- Evidence from new run (trace.json analysis)
- Current dedupeKey implementation dissection
- Risk matrix for 3 scenarios
- 4 design options with pros/cons analysis
- **Recommendation: Option A** (add domOrder)
- Regression test cases (5 scenarios)

**Read time: 30 minutes** | **For**: Deep technical understanding, architecture review

### 3. **src/discovery/__tests__/classifier.test.ts** (REGRESSION TESTS)
14 passing tests verifying:
- **Current implementation**: Existing behavior (including known collision)
- **Enhanced implementation**: Proposed behavior with domOrder
- **stableIdSuffix**: Extraction logic (4 tests)

**Status**: ✅ ALL PASSING (14/14)

**Run**: `npx tsx --test src/discovery/__tests__/classifier.test.ts`

---

## Key Findings

### The Problem (Latent, Not Yet Manifesting)

Multiple fields with the same label in the same section and no semantic ID suffix → **dedupeKey collision**.

Example:
```
Row 1 Customer Number: section="Partner Function Data", id="" 
Row 2 Customer Number: section="Partner Function Data", id=""
→ dedupeKey: "valueHelp|partner function data|customer number" (SAME = COLLISION)
```

### The Solution (Option A)

Add `domOrder` (document order position) as a tertiary identity signal:

```
NEW dedupeKey for Row 1: "valueHelp|partner function data|customer number|100"
NEW dedupeKey for Row 2: "valueHelp|partner function data|customer number|101"
→ DISTINCT (no collision)
```

### Why Not Implemented Yet

The user's explicit requirement: **"Do not modify dedupeKeyFor() yet. First perform an identity audit."**

This audit is that audit. Implementation requires explicit approval after reviewing:
1. This summary
2. The full audit
3. The test suite

---

## What's NOT Changing

✅ **stableIdSuffix()** — working correctly  
✅ **stableIdSelector()** — working correctly  
✅ **Tier 1 (semantic suffix)** — still highest priority  
✅ **Tier 3a (section + label)** — still fallback for unique labels  

## What IS Changing (When Approved)

📝 **dedupeKeyFor()** signature — add optional `domOrder` parameter  
📝 **dedupeKeyFor()** tiers — reorder to: Tier 1 → Tier 3b → Tier 3a → Tier 2 → Tier 4  
📝 **Call sites** — pass `domOrder` when building ControlDescriptor  

---

## Risk Assessment

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|-----------|
| domOrder changes mid-discovery | ⚠️ MEDIUM | 🟡 MEDIUM | Ensure atomic discovery |
| Selector collision | ❌ LOW | 🔴 HIGH | Never (unique DOM order) |
| False regression | ✅ VERY LOW | 🟡 MEDIUM | Comprehensive test suite |

---

## Current Status

| Phase | Status | Evidence |
|-------|--------|----------|
| Analysis | ✅ COMPLETE | AUDIT_CONTROL_IDENTITY.md |
| Test Design | ✅ COMPLETE | classifier.test.ts (14/14 passing) |
| Risk Assessment | ✅ COMPLETE | Risk matrix in AUDIT_CONTROL_IDENTITY.md |
| Implementation | ⏸️ AWAITING APPROVAL | Ready to proceed when approved |

---

## Next Steps

### If Approved for Implementation:

1. Modify `src/discovery/classifier.ts`
   - Update `dedupeKeyFor()` signature
   - Reorder tiers
   - Update call site

2. Run full test suite
   ```bash
   npx tsx --test src/discovery/__tests__/classifier.test.ts
   npx tsc --noEmit
   npm test  # if full suite exists
   ```

3. Manual verification
   ```bash
   npm run capture -- [test-app-url]
   # Check trace.json: Customer Number should appear 5 times (expected)
   # Check report: points, controls should be in line with expectations
   ```

### If Deferred (Separate Task):

1. Keep this audit as reference for future work
2. Document in task tracking system
3. Create separate task for identity enhancement

---

## Files Location

```
C:\screenshot system\
├── IDENTITY_AUDIT_SUMMARY.md           ← THIS FILE
├── AUDIT_CONTROL_IDENTITY.md           ← Full audit
├── IDENTITY_WORK_PRODUCTS.md           ← Index
└── src\discovery\__tests__\
    └── classifier.test.ts              ← 14 tests (all passing)
```

---

## Approval Checklist

- [ ] Read IDENTITY_AUDIT_SUMMARY.md
- [ ] Read AUDIT_CONTROL_IDENTITY.md (at least "Options" section)
- [ ] Review classifier.test.ts test scenarios
- [ ] Approve Option A (domOrder-based identity)
- [ ] Approve implementation checklist

Once approved, implementation is straightforward and low-risk.

