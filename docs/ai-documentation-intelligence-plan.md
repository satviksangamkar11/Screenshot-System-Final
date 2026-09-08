# AI Documentation Intelligence — Locked Architecture

Status: **Locked for implementation.** This is a design decision record, not a summary generator spec. It replaces the current full-page-screenshot vision pipeline in `src/summary/`.

## The core decision

> Never make a probabilistic model rediscover information the browser engine has already established. Use AI only after captured UI behavior has been converted into structured facts.

The capture engine (discovery → interaction → trace) already knows every control's kind, label, section, and how it was interacted with. The AI/vision pipeline in `src/summary/generate.ts` currently throws that away and re-derives structure from pixels. This plan removes vision from the normal path entirely and builds a deterministic documentation-intelligence layer on top of the evidence that already exists.

## Architecture

```
Existing capture (discovery + interaction + trace) — untouched
      ↓
UiDocumentationModel
(Page → Section → Container? → Control)
      ↓
Label validation / anonymization
      ↓
Structural + interaction facts
      ↓
Role inference
      ↓
Pattern detection
      ↓
Documentation facts
      │
      ├── Single version
      │      ↓
      │   3–8 UI documentation points
      │
      └── Old vs New
             ↓
        Section diff
             ↓
        Container diff
             ↓
        Control multiset diff
             ↓
        Interaction/capability diff
             ↓
        Pattern diff
             ↓
        3–8 change points
      ↓
Template rendering
      ↓
Optional LLM wording polish
      ↓
DOCX — AI section last
```

Vision stays as a narrow escape hatch, never the foundation:

```
ExceptionRecord OR unclassified control OR UNRESOLVED comparison
      ↓
targeted screenshot (not full-page)
      ↓
vision
      ↓
supplemental fact
```

Normal path: zero vision calls, zero-to-one small text-model call.

## The model

```
Page
 └── Section
      └── Container?              (type: group | table | toolbar | dialog — optional)
           └── Control
```

No `Region` above Section — six real captures (a rich Fiori CRM form, two flat WebGUI/WebDynpro Z-transactions, three non-SAP sites) never once needed one. `Container` is genuinely optional, not mandatory with a bigger sibling.

Every node (Page/branch, Section, Container, Control) carries:

```
rawLabel
canonicalLabel
meaningfulLabel        (true/false — a naming decision, not an existence decision)
kind / type
parent
order?                 (only meaningful when the adapter says so)
structuralRole?
semanticRole?
interactionKind         (deterministic: how the engine treats this control)
observedInteractionResult  (runtime: what actually happened when interacted with)
state
sourceAdapter
evidenceRefs
```

Include every control, not just `POINT_KINDS` — that set answers "does this earn a screenshot," a different question from "what is this section made of."

## The rules

**Structure.** Adapter-specific discovery (UI5, Web Components, Web Dynpro, WebGUI, generic ARIA/DOM), normalized into one common model via an extension to the existing `TechnologyAdapter` contract (`containerType`, `ordersAreMeaningful?: boolean` — same opt-in pattern as the existing `supportsIdSuffixFallback`).

**Groups/containers.** Optional. Never invented when the adapter can't establish one. A container's identity for matching is `type + parent path + label if available + structural signature` — no positional/occurrence component. Two containers with identical (type + parent + signature) and no adapter-confirmed meaningful order follow the same multiset rule as controls (below), never a positional 1st-vs-1st pairing.

**Labels.** `hasMeaningfulLabel` (already implemented in `src/discovery/labels.ts`) gates every tier — Page/branch, Section, Container, Control. A bad label (`.`, a bare `X` from a dismiss icon, punctuation-only) does **not** delete the node or its children. The node stays structurally present, holds its real children, and is represented internally as `anonymous-section` / `anonymous-container` / etc. It is excluded only from: becoming a named documentation point, being presented by name, and being used as a named identity in matching or facts. This single distinction — a node can be structurally real without a documentable name — fixes a proven, recurring capture defect (confirmed across `ZCENTER FEE`, `ZDME DISP`, and `ptssystems.co.in`, where identical or junk labels corrupted section headings and even page-tree branches).

**Matching (Old vs New, applied recursively at every level — Section, Container, Control).**
- Same parent + canonical label + kind, exactly one on each side → **CONFIRMED**. Compare properties → CHANGED or unchanged.
- Same parent + kind, exactly 1 old / 1 new, no label match → may be described as a possible rename/replacement, explicitly hedged ("Vendor no longer appears; Deposit Payee appears in its place — possibly renamed").
- Any other count on either side (including equal counts > 1) → **never** paired individually, positionally or otherwise. Report as a composition/count change ("2 value-help fields were removed and 2 were added in Partner Function Data").
- No defensible correspondence at all (structure diverged too far, depth changed) → **UNRESOLVED** — a real output finding, not silence and not a forced guess.

**State.**
- Structural/capability facts (kind, opens-a-dialog, section, container type, `interactionKind`) — safe to compare.
- Crawl outcomes (`observedInteractionResult`, which option got selected, which tab ended active) — retained as single-version documentation evidence, never auto-reported as a version difference in v1.
- Baseline (pre-interaction default state) and the finer configuration tier — both deferred; neither exists as captured data today (`ControlDescriptor` has no value/state field), so don't split them apart under new terminology until the capture work is actually built.

**Patterns.** Derived from normalized semantic roles (kind + container type + interaction only — never section identity, never a dependency on pattern detection itself, to avoid circularity), grounded in real captured structures rather than an assumed universal vocabulary. Carry `sourceAdapter` as provenance metadata but don't block matches on it — a filter/toolbar pattern recurring across a WebGUI Old version and a UI5 New version is likely the most valuable finding this tool can produce for a modernization project. Occurrence count sets the strength: 3+ = strong recurring pattern, 2 = medium, 1 = not a pattern.

**Facts and TL;DR selection.** Deterministic relevance rules, not LLM judgment:
- HIGH: major section structure, a pattern with 3+ occurrences, a branch/dialog reveal, a non-default observed state, a confirmed Old/New change.
- MEDIUM: a single meaningful interaction, a 2-occurrence pattern.
- Everything else excluded.
- Fill HIGH first, MEDIUM to pad, dedupe, cap at 8, floor at 3 — or fewer, or zero, if that's honest. A page with no documentable UI evidence gets exactly that sentence, not padding and not silence, with a specific reason (blocked / timeout / unsupported) attached only if the engine can actually detect it — otherwise the generic honest line.

**AI.** Not responsible for discovering facts, ever. At most: `facts → templates → 3–8 points`, with an optional LLM wording-polish pass afterward that may not introduce a new fact. Test whether templates alone are good enough before wiring the LLM call in at all.

**Vision.** Exception-only fallback: `ExceptionRecord`, unclassified control, or `UNRESOLVED` comparison → one targeted screenshot → vision → one supplemental fact. Never full-page screenshots, never the foundation.

**Output.** Only externally meaningful categories are ever shown to the user: `ADDED / REMOVED / CHANGED / STRUCTURE / BEHAVIOR / STATE / UNRESOLVED`. Internal matcher terminology (`CONFIRMED`, multiset counts, provenance) stays internal.

## Build order

1. Golden specifications — technology-matrix aware (UI5, Web Components, Web Dynpro, WebGUI, generic ARIA), each covering: 2+ sections, repeated containers where applicable, duplicate labels, junk labels at every tier, buttons/actions, interaction controls, unlabeled structural nodes, near-empty capture. Plus the full comparison matrix: same / add / remove at each level / 1:1 rename-like / N:M composition / reorder / split / merge / unresolved.
2. Extend the adapter contract: `containerType`, `ordersAreMeaningful`.
3. `UiDocumentationModel` — all controls, not just `POINT_KINDS`.
4. Label validation/anonymization at every tier.
5. Structural/interaction/outcome separation.
6. Role inference (kind + container type + interaction; no section identity; no pattern dependency).
7. Pattern detection on normalized roles, provenance-tagged, cross-technology allowed, occurrence-thresholded.
8. Documentation facts (deterministic relevance rules).
9. Single-version documentation (templates first — decide on the LLM call only after).
10. Section comparison.
11. Container comparison.
12. Control multiset comparison.
13. Interaction/capability comparison.
14. Pattern comparison.
15. Comparison documentation.
16. Template quality evaluation.
17. Optional LLM wording polish.
18. Overlay-result enrichment (UI5 + Web Components first) — its own scoped project, started only once 1–17 have shipped and proven the facts layer is worth enriching for the remaining technologies.
19. Targeted vision fallback for exceptions only.

Rename the feature surface as part of steps 9 and 15: `AiSummaryResult` and its consumers (`src/server/jobs.ts`, `src/server/app.ts`, `src/server/public/index.html`) carry the current contract and need updating alongside the internal rewrite, not as an afterthought.

## What was deliberately rejected

- A graph data structure for relationships — the existing tree (`document/tree.ts`'s `PageNode`, extended with typed edges) already does this.
- Numeric/scored importance (`+3`, `-2`, confidence percentages) — explicit categorical rules instead.
- A fuzzy, confidence-scored Old/New matcher (`MATCH` / `PROBABLE_MATCH` / `NO_MATCH` / `AMBIGUOUS`) — replaced by the conservative one-to-one-or-composition rule above, which needs no threshold calibration.
- `Region` as a level above Section — never motivated by a real capture across five technologies.
- Positional/occurrence-based disambiguation of duplicate controls or containers — multisets only.
- Sending every full-page screenshot to a vision model — the mechanism the current `src/summary/generate.ts` uses today, and the single biggest cost/reliability problem this plan removes.

## Remaining work before implementation

Adapter-specific structural-context fixtures (the existing `fixtures/webgui-screen.html` and `fixtures/webdynpro-form.html` are single-section smoke tests with no repeated containers — extend them, and add a generic-ARIA fixture, none currently exists) and the full comparison golden-case matrix. The architecture itself is locked; what's left is validation material to build against it.
