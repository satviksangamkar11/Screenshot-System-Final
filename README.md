# UI Documentation Engine

Automates a real browser against an enterprise web application (SAP Fiori / UI5 / FPM building blocks / `@ui5/webcomponents` / Web Dynpro ABAP / WebGUI), discovers every documentable control, interacts with it, captures screenshot evidence, and assembles a Word document. Two summaries are then produced from that same evidence: a deterministic **General Summary** and an LLM-written **AI Summary** whose every claim is validated against real captured evidence before it is shown.

> **Structured evidence only — never pixels.** No vision model is used anywhere. The LLM receives the semantic model, derived facts, patterns and diff that this codebase already computed — never `trace.json` wholesale, never a screenshot.

> **End users need nothing installed.** No Node.js, no Chrome/Edge, no account. Just open the hosted server's URL in whatever browser they already have. Node.js + a browser are required only on the **one machine that runs the server** — see [Requirements](#requirements).

---

## TL;DR

- Two-stage pipeline: **Capture** (drives a browser, writes `trace.json` + screenshots) → **Assemble** (pure function, builds the `.docx`, never opens a browser).
- Talks to Chrome/Edge directly over the **Chrome DevTools Protocol** — no Playwright, no Puppeteer, no browser-binary download.
- Five **technology adapters**, tried in priority order, each claiming the controls it recognizes: UI5 framework → `@ui5/webcomponents` → Web Dynpro ABAP → WebGUI/ITS → generic ARIA/DOM fallback.
- A control becomes a **documentation point** only if interacting with it reveals something worth a screenshot (dropdown, calendar, lookup, checkbox, file upload, or a button that opens new UI) — plain text fields are filled but not separately screenshotted.
- **Two summaries, two tabs.** *General Summary* — the deterministic pipeline (`src/doc-intelligence/`), zero network calls. *AI Summary* — an LLM explanation built from that same structured model, with every point's evidence citations validated server-side before display.
- **Evidence-backed or dropped.** An AI point citing evidence that isn't in the capture is discarded, not shown. Unsupported claims never reach the document.
- **Graceful degradation.** If no API key is set, every provider is down, or the response is malformed, the AI path falls back to the deterministic pipeline automatically. The document is never blocked by an LLM failure.
- **Key rotation built in** — three Groq keys tried in order, then a Gemini fallback (`src/llm/client.ts`).
- Runs as a **shared web server**: each browser gets its own cookie-isolated session, no cross-user leakage.
- **Manual data-entry mode** — the operator fills each field themselves through a streamed live view, while the engine still handles discovery, screenshots and assembly.
- Also runs from the **CLI** against a named `config/apps/<app>.yaml`, for repeatable/scripted captures.

---

## 1. Two-Stage Architecture

```
config/apps/<app>.yaml  (CLI)  ──┐
pasted URL(s)           (web) ───┼──►  buildAppConfig
                                 │
                                 ▼
                          ┌─────────────┐
                          │  CAPTURE    │  drives the browser, one run per version
                          │             │  src/orchestrator/capture.ts
                          └──────┬──────┘
                                 ▼
                 output/runs/<runId>/{trace.json, screenshots/, report.json}
                                 │
                                 ▼
                          ┌─────────────┐
                          │  ASSEMBLE   │  pure function of the trace; never opens a browser
                          │             │  src/orchestrator/assemble.ts
                          └──────┬──────┘
                                 ▼
                    output/jobs/<jobId>/<Title>.docx
                                 │
                                 ▼ (once a document exists)
                    ┌────────────┴────────────┐
                    ▼                         ▼
          ┌──────────────────┐      ┌──────────────────┐
          │ GENERAL SUMMARY  │      │   AI SUMMARY     │
          │ deterministic    │      │ LLM + evidence   │
          │ facts/diff       │      │ validation       │
          │ (no network)     │      │ src/llm/         │
          └──────────────────┘      └────────┬─────────┘
                                             ▼
                                  rebuilds the .docx with an
                                  appended AI Summary section
```

**Key properties:**
- Capture and Assemble are fully decoupled — a trace can be re-assembled into a fresh `.docx` (formatting fixes, summaries added later) without repeating a slow capture run.
- `trace.json` is the **only** contract between the two stages.
- Both summaries read the same trace(s) already on disk — no re-capture, no browser.
- **The two summary tracks are independent.** Each carries its own status, so a failed LLM call still leaves a fully populated General Summary.

---

## 2. Request Lifecycle (URL → `.docx`)

```
┌────────────────┐     POST /api/generate      ┌──────────────────┐
│  Web UI / CLI   │ ───────────────────────────► │  server/jobs.ts  │
└────────────────┘                              │   startJob()     │
                                                 └────────┬─────────┘
                                                          ▼
                                         ensureSessions() — sign-in per version
                                                          │
                                                          ▼
                                  orchestrator/capture.ts : captureVersion()
                                                          │
                    ┌─────────────────────────────────────┼─────────────────────────────────────┐
                    ▼                                     ▼                                     ▼
       browser/manager.ts opens a CDP           discovery/classifier.ts               state/explorer.ts
       session (chrome-launcher +               walks the adapter registry,           drives the traversal:
       page-shim / locator-shim)                builds ControlDescriptor[]            readiness → discover →
                                                                                       interact → capture → repeat
                                                          │
                                                          ▼
                                     interaction/handlers/*  dispatches per ControlKind
                                     (fields.ts / buttons.ts / open-overlay.ts)
                                                          │
                                                          ▼
                                          evidence/store.ts : EvidenceStore.capture()
                                          screenshots + Evidence record appended
                                                          │
                                                          ▼
                                   trace.json + report.json written (per version)
                                                          │
                                                          ▼
                                  orchestrator/assemble.ts : assembleDocument()
                                                          │
                                                          ▼
                                    document/builder.ts : buildDocument() → .docx
                                                          │
                                                          ▼ (once the document exists)
                     POST /api/jobs/:id/ai-summary → requestAiSummary()
                                                          │
                          ┌───────────────────────────────┴───────────────────────────────┐
                          ▼                                                               ▼
        generateDocumentationPoints()                            generateAiDocumentationPoints()
        deterministic → job.generalSummary                       ai-context.ts → llm/client.ts
                                                                 → validate refs → job.aiSummary
                                                                 → appended into the same .docx
```

Both tracks are started by one request and polled through the existing `GET /api/jobs/:id`
status endpoint — `generalSummaryStatus` and `aiSummaryStatus` settle independently.

---

## 3. Technology Adapter Stack

TL;DR:
- Controls are discovered in **priority order**; each adapter claims what it recognizes, later adapters skip anything already claimed.
- One list (`discovery/adapters/registry.ts`) drives **both** control discovery and page-identity fingerprinting, so "which technology owns this page" is decided once, consistently.
- Every adapter exposes the same three-method contract: `detect()`, `probe()`, `classify()` (plus optional `fingerprint()` and `containerType()`).

```
ui5Adapter             sap.m.* / sap.ui.* / sap.ui.mdc.* JavaScript framework controls
        │
webcomponentsAdapter   @ui5/webcomponents custom elements (ui5-input, ui5-select, …)
        │
webdynproAdapter       SAP Web Dynpro ABAP (Lightspeed renderer, [lsdata] attribute)
        │
webguiAdapter          SAP WebGUI / SAP GUI for HTML (ITS "Unified Rendering")
        │
ariaDomAdapter         Generic ARIA-semantic elements on any page — always-last fallback
```

### 3.1 SAP UI5 JavaScript framework — `ui5Adapter`

- Reads `sap.ui.core.Element.registry` (modern) or `sap.ui.getCore().mElements` (legacy) to enumerate every **live** UI5 control — no DOM guessing.
- Covers both classic `sap.m.*` controls **and** the `sap.ui.mdc.*` building-block controls Fiori Elements for OData V4 actually renders (`Field`, `FilterField`) — these are structurally different from classic controls (different editability/value-help APIs) and are handled with dedicated fallbacks.

| Control family | Kind |
|---|---|
| `Input`, `MaskInput`, `StepInput`, `mdc.Field`, `mdc.FilterField` | `input` (or `valueHelp` if a value-help/field-help is associated) |
| `TextArea`, `RichTextEditor` | `textarea` |
| `Select`, `ComboBox` | `select` |
| `MultiComboBox`, `MultiInput` | `multiSelect` |
| `DatePicker`, `DateTimePicker`, `TimePicker`, `WheelTimePicker` | `date` |
| `DateRangeSelection`, `DynamicDateRange` | `dateRange` |
| `CheckBox`, `RatingIndicator`, `Switch` | `checkbox` |
| `RadioButton`, `SegmentedButton`, `SegmentedButtonItem` | `radio` |
| `FileUploader`, `UploadSet` | `fileUpload` |
| `Button`, `ToggleButton`, `MenuButton`, `OverflowToolbarButton`, `Link`, `Avatar`, `ObjectMarker`, `ObjectIdentifier`, `ExpandableText`, `SmartLink`, `QuickViewCard` | `actionButton` |
| `GenericTile`, `Card` | `revealButton` |
| `IconTabFilter`, `WizardStep` | `tab` |
| `Slider`, `RangeSlider`, `ColorPicker` | `input` |
| `ObjectStatus`, `ProgressIndicator`, `DraftIndicator`, `ObjectNumber`, `Token`, `Tokenizer`, `MessageStrip`, `Column` | `readonly` |
| All `*MicroChart` types, `KPIHeader`, `VizFrame`, `Chart` | `readonly` |

**Section identity** (`sectionOf`) walks the UI5 parent chain for `Panel`, `IconTabFilter`, `ObjectPageSection`, `ObjectPageSubSection`, `Dialog`, `FormContainer`, `Form`, `SimpleForm`, `DynamicPage`, `DynamicPageTitle`, `ObjectPageHeader`, `ObjectPageHeaderTitle`, `BlockBase`, `SmartForm`, `Group`, `GroupElement`, `FilterBar`, `Table`, `Chart` — covering every SAP FPM building-block container, classic and V4.

**Container identity** (`containerOf`, separate from section identity) walks the same parent chain but answers a different question — *what structural shape is the immediate container* — and feeds `ContainerType` (`group` / `table` / `toolbar` / `dialog`) all the way through to the AI Summary's diff engine:

| Ancestor control type | Container kind |
|---|---|
| `Table`, `TreeTable`, `AnalyticalTable`, `GridTable` | `table` |
| `Toolbar`, `OverflowToolbar` | `toolbar` |
| `Dialog`, `Popover` | `dialog` |
| `Panel`, `FormContainer`, `Form`, `SimpleForm`, `SmartForm`, `Group`, `GroupElement`, `ObjectPageSection`, `ObjectPageSubSection`, `FilterBar` | `group` |

### 3.2 SAP FPM building blocks — coverage

| Building Block | Renders as | Classification |
|---|---|---|
| **Field** | classic `sap.m.Input/Select/DatePicker/...` **or** `sap.ui.mdc.Field` (V4) | per field type |
| **Filter Bar** | classic filter fields **or** `sap.ui.mdc.FilterField` (V4) | per field type |
| **Form** | `sap.ui.layout.form.Form` / `SimpleForm` | section grouping |
| **Table** | `sap.m.Table` columns (`aria-sort`), toolbar buttons | `actionButton` / `readonly` |
| **Micro Chart** | `BulletMicroChart`, `AreaMicroChart`, `RadialMicroChart`, … | `readonly` |
| **Message Button** | `sap.m.Button` with badge | `actionButton` |
| **Chart** | `sap.viz.ui5.controls.VizFrame`, `sap.chart.Chart` | `readonly` |
| **Rich Text Editor** | `sap.ui.richtexteditor.RichTextEditor` | `textarea` |
| **AI Notice** | read-only strip | `readonly` |
| **KPI Tag** | `KPIHeader` | `readonly` |
| **Page** | `DynamicPage`, `ObjectPageHeader` | section grouping |
| **Flexible Column Layout Actions** | close/expand buttons | `actionButton` |
| **Share** | `sap.m.Button` (opens Popover) | `actionButton` |
| **Status** | `DraftIndicator` | `readonly` |
| **Paginator** | nav buttons | `actionButton` |
| **Actions** | toolbar `sap.m.Button` elements | `actionButton` |

### 3.3 `@ui5/webcomponents` — `webcomponentsAdapter`

- Discovers `ui5-*` custom elements anywhere on the page, **including inside nested shadow roots**, via `walkShadowElements`.

| Tag(s) | Kind |
|---|---|
| `ui5-input`, `ui5-step-input`, `ui5-slider`, `ui5-range-slider` | `input` |
| `ui5-textarea` | `textarea` |
| `ui5-select`, `ui5-combobox` | `select` |
| `ui5-multi-combobox`, `ui5-multi-input` | `multiSelect` |
| `ui5-date-picker`, `ui5-time-picker`, `ui5-datetime-picker` | `date` |
| `ui5-date-range-picker` | `dateRange` |
| `ui5-checkbox`, `ui5-switch`, `ui5-rating-indicator` | `checkbox` |
| `ui5-radio-button`, `ui5-segmented-button` | `radio` |
| `ui5-file-uploader`, `ui5-upload-collection` | `fileUpload` |
| `ui5-tab` | `tab` |
| `ui5-button`, `ui5-toggle-button`, `ui5-link`, `ui5-menu-item`, `ui5-avatar`, `ui5-breadcrumbs-item`, `ui5-tree-item` | `actionButton` |
| `ui5-card` | `revealButton` |

- `ui5-input[show-value-help]` always overrides the kind to `valueHelp`, regardless of tag.

### 3.4 SAP Web Dynpro ABAP — `webdynproAdapter`

- Detected by `[lsdata]` elements present with **no** UI5 runtime on the page (UI5, when present, is always the more precise source of truth).
- `lsdata.ts` is the **only** module that parses the Lightspeed renderer's single-quoted, positional-array-literal `lsdata` attribute — a hand-written tokenizer, returns `null` (not a throw) on anything outside the documented shape.

| `lsdata` control type | Kind |
|---|---|
| `InputField` (with value help) | `valueHelp` |
| `InputField` (`dataType: DATE`) | `date` |
| `InputField` (otherwise) | `input` |
| `DropDownByKey`, `DropDownByIndex` | `select` |
| `CheckBox` | `checkbox` |
| `RadioButton` | `radio` |
| `FileUpload` | `fileUpload` |
| `Button`, `LinkToAction` | `actionButton` |
| `Tab` | `tab` |

- Web Dynpro ids (`WD01`, `WD02`, …) are session-stable and exact — the UI5 id-suffix fallback is switched off for this adapter.

### 3.5 SAP WebGUI / SAP GUI for HTML — `webguiAdapter`

- Detected by an `/its/webgui` URL segment, or by the `M0:`-pattern coordinate ids + `ur*`-prefixed CSS classes ITS always emits.
- No live control registry to introspect — classification reads rendered CSS class plus structural signals.

| Signal | Kind |
|---|---|
| `urEdf2TxtDsbl`, or `disabled`/`readOnly` | `readonly` |
| native `input[type=checkbox]` | `checkbox` |
| native `input[type=radio]` | `radio` |
| sibling F4/possible-entries trigger present | `valueHelp` |
| `urEdf2TxtEnbl` | `input` |
| `urCbo` | `select` |
| `urTab` | `tab` |
| `urBtn*` family | `actionButton` |

- Plugs a **title-based deny check** into the shared safety gate (`registerExtraDenyCheck`) — an icon-only button whose `title` attribute matches a deny rule is blocked even with no visible label.
- WebGUI ids encode screen coordinates, reassigned on every redraw — id-suffix fallback switched off, same as Web Dynpro.

### 3.6 Generic ARIA / DOM — `ariaDomAdapter`

Always-last fallback; covers standard HTML roles for any technology not otherwise recognized.

| Selector / Role | Kind |
|---|---|
| `input`, `select`, `textarea` | per HTML type |
| `[role="button"]`, `[role="menuitem"]`, `[role="tab"]` | `actionButton` |
| `[role="checkbox"]`, `[role="switch"]` | `checkbox` |
| `[role="radio"]` | `radio` |
| `[role="listbox"]` | `select` |
| `[role="slider"]`, `[role="spinbutton"]`, `input[type="range"]` | `input` |
| `[role="treeitem"][aria-expanded]` | `actionButton` |
| `[role="columnheader"][aria-sort]` | `actionButton` (sort trigger) |

- Also pierces shadow roots for the same selectors, so controls inside custom elements no earlier adapter claimed are still found.

---

## 4. What Becomes a Documentation Point

TL;DR: a control earns a label + screenshot only if there's something worth *seeing* — an opened state, a chosen value, a revealed dialog.

**Included:**
- dropdown · calendar/date picker · value help/lookup · multi-select · checkbox/switch/radio · file upload
- a **button that reveals new UI** (dialog, popup, page) — determined by click-and-diff, not by label guessing

**Excluded:**
- plain text inputs/textareas — filled and committed (so dependent fields react, the form reaches a realistic state), but no screenshot of their own
- read-only/display-only fields — not interactive, not evidence
- pure action buttons (Save, Search, Execute) — nothing visibly changes
- dialog dismissal buttons (OK, Cancel, Close) — clicking them tears down the state being documented
- **a button that only collapses/hides existing UI** (e.g. "Hide Navigation") — see [Collapse vs. reveal](#collapse-vs-reveal-detection) below; this is *not* a documentation point even though the page visibly changed

For controls that open an overlay, **the opened state is the evidence** — screenshot taken with the dropdown expanded or the lookup dialog visible, before a value is chosen.

### 4.1 Collapse vs. reveal detection

- A button's kind can't be known until it's clicked — `probeButton()` fingerprints the page, clicks, and compares.
- A naive "did the fingerprint change" check can't tell **"something appeared"** apart from **"something disappeared"** — collapsing a sidebar changes the fingerprint exactly as much as opening a dialog.
- `visibleControlCount()` (`discovery/fingerprint.ts`) counts visible interactive elements before/after. A count dropping to ≤60% of before (floor of 6, so one field's dependents redrawing doesn't trip it) is treated as a **collapse, not a reveal**:
  - not documented
  - the same control is clicked again, best-effort, to restore the prior state
  - prevents every already-queued control behind the collapsed panel from failing "element no longer in the page" in a cascade

---

## 5. Container & Section Model (summary input)

TL;DR: discovery doesn't just find controls — it establishes **where** each one lives, and that identity survives all the way to the diff engine.

```
Page
 └─ Section              (Panel / Form / ObjectPageSection / FilterBar / Table / Chart title)
     ├─ Container         (table / group / toolbar / dialog — from containerOf())
     │   ├─ Control
     │   └─ Control
     └─ Control            (directly in the section, no container)
```

- `Evidence.containerType` / `Evidence.containerLabel` are threaded from `ControlDescriptor` (set by the adapter's `containerType()` hook) through `EvidenceStore.capture()` into `trace.json`.
- `doc-intelligence/build-model.ts`'s `placeControl()` groups controls sharing a `type::label` container identity into one `ContainerNode` — two fields discovered inside "the same table" land together; an untitled table never merges with an unrelated untitled toolbar in the same section.
- This is what lets the AI Summary diff engine report **container-level** changes (a table added/removed, a capability lost) — not just field-level ones.

---

## 6. Summaries — General (Deterministic) and AI (LLM)

The web UI shows both, side by side, as two tabs on one **Summary** panel:

```
┌─────────────────────────────────────┐
│  General Summary   |   AI Summary   │
└─────────────────────────────────────┘
```

Each tab carries its own status dot — grey (working) → green (ready) → red (failed) — because the two tracks succeed and fail independently.

### 6.1 General Summary — deterministic

**No LLM. No vision model. No network call. No API key.** Fully derived from the structured capture trace already on disk.

```
trace.json (per version)
        │
        ▼
build-model.ts     RunTrace → UiDocumentationModel (Page → Section → Container → Control)
        │
        ▼
patterns.ts        detectPatterns() — recurring control-group shapes (role multisets)
        │
        ▼
facts.ts           deriveFacts() — fixed relevance rules, single version
   OR
diff.ts            diffModels() — old vs. new comparison (multiset matching, never positional)
        │
        ▼
templates.ts       renderSinglePoints() — facts → TL;DR bullets, HIGH-first, deduplicated
```

- **Single version** → documentation points about structure, patterns, and interaction behavior.
- **Two versions** → categorised change points (`ADDED` / `REMOVED` / `CHANGED` / `COMPOSITION_CHANGE` / `UNRESOLVED` / capability / pattern), plus an overall change level (`no_change` / `minor` / `moderate` / `major`).
- **Multiset matching, never positional**: sections/containers/controls are matched by `kind + label` across two captures — never paired by list position. A 1:1 match is `CONFIRMED`; an N:M mismatch is `COMPOSITION_CHANGE`; a section with zero defensible correspondence is `UNRESOLVED` — an honest "can't tell" answer, not a guess.
- **Junk labels don't delete nodes.** A meaningless label (`"."`, a bare icon) anonymizes the node — it's still counted structurally, just excluded from named facts.

### 6.2 AI Summary — LLM over structured evidence

The same deterministic model is bundled into an **AI context** and sent to an LLM for a complete, readable explanation. Screenshots are never sent; `trace.json` is never sent wholesale.

```
UiDocumentationModel + facts + patterns + diff
        │
        ▼
ai-context.ts      builds the context + an evidence catalog the model may cite
        │            single mode:     seq numbers        (e.g. 12)
        │            comparison mode: namespaced refs    (e.g. "old:12", "new:7")
        ▼
llm/client.ts      Groq (key rotation) → Gemini fallback
        │
        ▼
ai-summary.ts      parse JSON → validate every cited ref against the catalog
        │            a point citing nothing valid is DROPPED, not shown
        ▼
AiSummaryResult    → rendered in the AI Summary tab + appended into the .docx
```

**What the AI tab adds over the General tab** — same capture, real output:

| General Summary | AI Summary |
|---|---|
| `Form · General section was added.` | `The Form → General section was added, containing fields like Due Date and RFA Reason.` |

- **Comparison mode** groups points into ordered sections — `ADDED` / `REMOVED` / `CHANGED` / `BEHAVIOR` / `STATE` / `STRUCTURE` / `UNRESOLVED` — each with a count, plus the overall-change bar. The whole old→new story reads in order rather than as one flat list.
- **Evidence validation is the safety net.** Points are accepted only if their `evidenceRefs` resolve against the catalog built from the actual capture. This is what makes the output checkable rather than plausible-sounding.
- **Fallback is automatic.** No keys configured, every provider failing, malformed JSON, or zero surviving points → the deterministic pipeline's result is returned instead, and the reason is logged.

### 6.3 LLM client — `src/llm/client.ts`

The single place in the codebase that talks to an LLM API. Any future feature needing one should import `chatComplete` rather than adding provider code of its own.

| Env var | Role |
|---|---|
| `GROQ_API_KEY` | Primary |
| `GROQ_API_KEY_2` | Rotated to on auth / rate-limit / server errors |
| `GROQ_API_KEY_3` | Rotated to next |
| `GEMINI_API_KEY` | Fallback once every Groq key is exhausted |
| `GROQ_MODEL` | Optional model override (default `openai/gpt-oss-120b`) |
| `GEMINI_MODEL` | Optional model override (default `gemini-3.6-flash`) |

- **Rotation is selective.** `401` / `403` / `429` / `5xx` rotate to the next key. A `404` (retired model id) does **not** — another key cannot fix a bad model name, so it fails fast instead of burning all three keys.
- **Model ids are env-overridable** because providers retire them regularly; that should be a config edit, not a code change.
- **Reasoning-model aware.** Groq's `gpt-oss` models spend reasoning tokens from the same `max_tokens` budget before emitting any content, so a tight cap silently returns empty output. The client uses a generous budget with `reasoning_effort: 'low'`.
- `.env` is loaded by a small built-in parser in `config/load.ts` — no `dotenv` dependency. Real environment variables always win over `.env` values.

### 6.4 Shared contract

`AiPoint` / `AiSummaryResult` (the shared render contract) are defined in `doc-intelligence/index.ts` and consumed by `document/builder.ts`, `orchestrator/assemble.ts`, and `server/jobs.ts`. The **AI** summary is what gets appended into the `.docx`.

---

## 7. Browser Automation Layer

- Talks to Chrome/Edge directly over **CDP** — no Playwright, no Puppeteer, no browser-binary download.

| Module | Role |
|---|---|
| `automation/chrome-launcher.ts` | Finds and launches the installed browser, returns its CDP WebSocket |
| `automation/cdp-client.ts` / `cdp-session.ts` | Protocol transport and per-target sessions |
| `automation/page-shim.ts` / `locator-shim.ts` | A small Playwright-shaped API (`page.locator(...).click()`) over raw CDP |
| `automation/storage-state.ts` | Saves/loads cookies + localStorage (Playwright-compatible JSON) |
| `automation/shadow-pierce.ts` | Shadow-DOM focus/read helpers for the interaction layer |

- `locator-shim.ts` implements the parts of Playwright's selector syntax the interaction layer relies on — `:visible`, `:has-text()`, `:text-is()` — because plain `querySelectorAll` rejects them as invalid syntax.
- `:text-is()` matches the **smallest** element holding the text (matching Playwright's own behavior); dialog actions click the element that actually owns the handler (a `button`, or `li[role="option"]`) — never a text node nested inside it.
- `npm run check:selectors` — standalone regression check for this engine.

### 7.1 Shadow DOM interaction

Web components render interactive parts (calendar toggle, value-help icon, dropdown arrow) **inside shadow roots** — light-DOM CSS selectors can't reach them.

`shadowPierceOrF4` (`interaction/handlers/open-overlay.ts`):
1. Tries `shadowRoot.querySelector(...)` via `page.evaluate()` to click the specific shadow element.
2. Falls back to focusing the host element and pressing **F4** — UI5's universal "open this control's picker" shortcut, works for both the framework and the web-components library.

| Kind | SAP framework selector first | Shadow / F4 fallback |
|---|---|---|
| `multiSelect` | `.sapMInputBaseIconContainer` | `.ui5-multi-combobox-toggle-button`, `.ui5-multi-input-toggle-button` |
| `valueHelp` | `.sapMInputValHelp`, `.sapUiIcon` | `.ui5-input-value-help-button`, `[slot="value-help-icon"]` |
| `date` / `dateRange` | `.sapUiIcon` | `.ui5-date-picker-toggle-button`, `.ui5-time-picker-toggle-button`, `.ui5-date-range-picker-toggle-button` |

---

## 8. Exploration Engine (`state/explorer.ts`)

TL;DR: a recursive traversal loop — readiness check → discover controls → interact → capture → recurse into anything newly revealed, bounded by budgets and loop detection.

### 8.1 Slow-loading applications
- Enterprise Fiori apps commonly need **20–100 seconds** before content exists (shell paints, then component loads, route resolves, data fetches).
- The engine waits on what actually rendered — controls or a dialog present, nothing busy, control count stable — not a fixed delay.
- Bounded by `budgets.appReadyTimeoutMs` (default 3 minutes).

### 8.2 Dialogs
- **Message dialogs** (`Error: field X is mandatory`, OK-only) — incidental, clicked through, never documented.
- **Chooser dialogs** (`Customer Category: Organization / Person`, 2+ real alternatives) — a branch point, see 8.6.

### 8.3 Full-page capture
- A whole-page capture is **consecutive viewport-sized screenfuls**, not one tall image — matching hand-made reference documents.
- Locates whatever actually scrolls (Fiori usually scrolls an inner container, not the window) rather than calling `window.scrollTo`.
- **Captured per section, not once at the end** — as each section finishes, it's photographed top-to-bottom immediately, while its own values are still on screen.

### 8.4 UI5 id churn
- A view without an explicit id gets an auto-generated global-counter prefix (`__xmlview2--DueDateId`) — re-instantiating the view renumbers it.
- **Fix:** every control carries a second, view-independent selector (`[id$="--DueDateId-inner"]`), preferred whenever it identifies exactly one element.

### 8.5 Loading overlays & editability
- A value-help dialog opens before its rows arrive — busy indicator, then a placeholder row. The engine waits for contents to settle before photographing/selecting.
- Every interaction is preceded by a fast check: present, visible, enabled, not read-only, not covered. A blocked control gets one attempt at clearing whatever covers it; still-blocked → skipped quietly, capture continues.

### 8.6 Branching
- When a dialog offers 2+ real alternatives, **all of them are documented**.
- For each option: capture the open dialog labelled with that option, take the branch, explore it fully, reload the application, take the next one.

### 8.7 Staying inside the application
- **Shell chrome is never discovered** — anything inside the Fiori Launchpad's shell header is skipped by both discovery probes.
- **Navigation is scope-checked** — the run is anchored to the semantic object of its entry URL. A link landing on a different one is captured as a point but never recursed into.
- **Known open gap:** a page whose own content links to dozens of unrelated sibling pages (a component catalog / demo browser, not shell chrome) can consume the whole run touring siblings before reaching its own content — this is a distinct, harder scoping problem from shell-chrome exclusion, and not yet solved generically.

### 8.8 Safety
- `safety.denyLabels` (Save, Submit, Post, Approve, Delete, …) — never clicked.
- `safety.allowLabels` (Search, Execute, Go) — read-only queries, explicitly permitted.

---

## 9. Data Model

All core types in **`src/types.ts`**; the AI Summary layer's own model in `src/doc-intelligence/model.ts`.

| Type | Represents |
|---|---|
| `ControlKind` | Every classified control type (`input`, `select`, `date`, `valueHelp`, `checkbox`, `revealButton`, `actionButton`, `tab`, `readonly`, `unknown`, …) |
| `POINT_KINDS` | Subset of `ControlKind` that earns a documentation point |
| `ContainerType` | `'group' \| 'table' \| 'toolbar' \| 'dialog'` — structural container identity, set by an adapter's `containerType()` hook |
| `ControlDescriptor` | A control discovered before interaction — id, `dedupeKey`, kind, label/canonicalLabel, section, selector(s), `containerType`/`containerLabel`, `isPoint` |
| `InteractionType` | What a screenshot is evidence of (`dropdownOpen`, `calendarOpen`, `valueHelpOpen`, `dialogOpen`, `fill`, `initialFullPage`, `finalFullPage`, …) |
| `Evidence` | One captured documentation point — label, screenshot path(s), interaction type, section/container identity |
| `PageState` | One page encountered during exploration (id, fingerprint, url, title, workflowPath) |
| `ExceptionRecord` / `SafetySkipRecord` | Internal-only audit records — never appear in the generated document |
| `ExecutionReport` | Per-run audit summary (pages visited, controls discovered/processed, points, exceptions, budget stops) |
| `RunTrace` | The full capture↔assembly contract — `{ runId, version, pages[], evidence[], report }`; serialised to `trace.json` |
| `UiDocumentationModel` | AI Summary's own tree: `Page → Section → Container? → Control`, built from `RunTrace` |

### `dedupeKey` — stable identity across re-discovery

- Selectors shift when a dialog opens or a section expands. Deduplication keys on the control's **meaning**, not position:
  1. UI5 view-independent id suffix (survives view renumbering) — preferred
  2. raw id — a framework-reused singleton re-attached under a different container each time is still the same control by id
  3. `section + label` — fallback only when there's no id at all

---

## 10. Web Server

```
src/server/
├── app.ts            HTTP routes + static file serving
├── jobs.ts            job lifecycle: sign-in orchestration, capture, assemble, summary tracks
├── adhoc.ts            builds an AppConfig from pasted URL(s) — no YAML file needed
├── remoteControl.ts    CDP screencast + input forwarding (live view during sign-in / manual mode)
├── userId.ts           per-browser cookie identity — session isolation on a shared server
└── public/
    ├── index.html       the SPA: URL form, mode toggle, Summary tabs, live view, log panel, capture toasts
    └── live.html         standalone full-tab live view page
```

**Job status payload** (`GET /api/jobs/:id`) — the summary-relevant fields:

| Field | Meaning |
|---|---|
| `generalSummaryStatus` / `generalSummary` / `generalSummaryError` | Deterministic track |
| `aiSummaryStatus` / `aiSummary` / `aiSummaryError` | LLM track |
| `captures` | Tail of the points whose evidence was confirmed written — drives the capture toasts (§10.3) |

The client polls until **both** report a settled state. Polling on one status alone would strand the other tab whenever it finished second.

- **Each browser gets its own session** — first request sets an opaque `HttpOnly` id cookie; every saved-session path is namespaced under it (`auth/.storage/<id>/<origin>.json`). Two people on the same shared server never see each other's SAP sessions.
- **Sign-in handled automatically** — the engine probes headlessly whether a site needs sign-in; if so, a live view streams into the page and the engine waits.
- URLs can be prefilled: `http://localhost:5173/?old=<encoded>&new=<encoded>`.
- Progress log distinguishes **positive confirmations** (green — "captured X") from **warnings** (amber) and **errors** (red) — a normal run should read as mostly green, not an unbroken stream of amber skip lines.

### 10.1 Data-entry modes

| Mode | Who fills the fields | When to use |
|---|---|---|
| **Automatic** *(default)* | The engine, from `config/testdata.yaml` rules | Normal runs — unattended, fastest |
| **Manual** | The operator, by hand in the live view | Fields needing real, valid business data the engine can't invent (customer numbers, contract ids) |

In **Manual** mode the engine still does everything else — discovery, interaction sequencing, screenshots, exception recording, assembly. It pauses at each discovered control and waits for the operator to **Submit** (accept what they typed) or **Skip**. The pending queue and the currently-waiting control are streamed to the page, so the operator always sees what is being asked of them.

Both modes capture the same overlay evidence at open time, so a document produced in Manual mode is structurally identical to an Automatic one.

### 10.2 Live view

A **CDP screencast** of the real browser, streamed into the page (`remoteControl.ts`), used in two situations:

- **Sign-in** — the engine probes headlessly whether a site needs authentication; if it does, the live view opens and the engine waits for the operator to sign in. The session is then saved and reused.
- **Manual mode** — the operator watches and types directly into the streamed page.

Input is forwarded back to the browser: keyboard (including modifier combinations), mouse, and scrolling. The view can be popped out to its own tab at `/live/jobs/<jobId>` (`live.html`) when the inline panel is too small.

### 10.3 Capture confirmations (toasts)

Each time a point's evidence lands on disk, a small toast appears in the
bottom-right corner of the page for ~2.6s:

```
✓ Screenshot captured
  Payment Type evidence saved
```

The message means what it says, and that is the whole design constraint:

- **Raised on success, not on request.** `EvidenceStore.capture()` deliberately
  keeps the `Evidence` record even when a screenshot fails — its `catch` logs a
  warning and carries on — and `assembleDocument` later drops any point whose
  file is missing, so "a record exists" is not the same claim as "this is in the
  document". The confirmation is emitted only once the image is verified present
  and non-empty on disk.
- **Structured, not scraped.** `EvidenceStore` emits a `CaptureEvent`
  (`src/evidence/events.ts`) through a sink registry mirroring the logger's;
  `jobs.ts` subscribes for the life of a run and appends to `job.captures`. The
  client diffs on id rather than parsing the Progress log back into data.
- **Job-scoped ids.** A run's own `seq` restarts at 1 for the second version, so
  the job assigns its own strictly-increasing id; the client remembers only the
  highest it has shown.
- **Never in the way.** The stack is `position: fixed` and click-through
  (`pointer-events: none`), because it overlaps exactly where Manual mode's
  Submit/Skip controls and the live view can sit. At most three are visible; a
  burst between two polls shows the newest and drops the rest rather than
  queueing stale confirmations behind the current one.

Both data-entry modes raise them, and they are additional to — not a
replacement for — the green "captured X" lines in the Progress log.

### 10.4 Session isolation and re-authentication

- Sessions are stored **per origin, per browser identity** — two versions on the same host require only one sign-in.
- Every sign-in completes **before any capture starts**, so a run never stalls halfway waiting for a human.
- If a saved session has silently expired, the capture raises a `SessionError`; the engine reopens sign-in once, then retries that version automatically.
- A version whose sign-in never completes is **skipped, not fatal** — the remaining versions are still documented, and the UI reports which one was left out.

---

## 11. Command Line

```bash
# 1. Sign in once per version.
npm run login -- --app <app> --version-id new

# 2. Capture each version.
npm run capture -- --app <app> --version-id old
npm run capture -- --app <app> --version-id new

# 3. Build the document.
npm run assemble -- --app <app>
```

Or all in one go: `npm run run -- --app <app>`

- Useful flags: `--headed` (watch the browser), `--verbose` (per-control logging), `--out <path>`.
- Applications reachable without login can set `requiresAuth: false` and skip step 1.

---

## 12. Requirements

**These apply only to the machine running the server — not to the people using it.**

| Requirement | Why |
|---|---|
| **Node.js ≥ 20** | Runs the engine and the web server |
| **Google Chrome _or_ Microsoft Edge** | Driven directly over CDP — no browser download step |
| **An LLM API key** *(optional)* | Only for the AI Summary tab. Without one, the General Summary still works and the AI tab falls back to it. |

- Edge is Chromium-based and speaks the same protocol — a stock Windows machine with no Chrome works unchanged.
- Nothing else needed — no ChromeDriver, no Playwright/Puppeteer binaries, no Docker.
- No LLM **SDK** dependency either — the client uses Node's built-in `fetch` against the providers' HTTP APIs.
- The served web page itself has **zero external dependencies** (no CDN scripts, no fonts) — end users need nothing beyond a browser.

---

## 13. Setup

```bash
npm install
npm run serve
```

Open `http://localhost:5173`, paste one or both URLs, press **Generate Document**.

### Running as a shared server

```powershell
New-NetFirewallRule -DisplayName "UI Documentation Engine (port 5173)" `
  -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private
```

```powershell
# Starts whenever you log in. Add -AtStartup to start at boot as SYSTEM.
.\scripts\install-service.ps1
.\scripts\uninstall-service.ps1   # remove
```

---

## 14. Configuration

| File | Purpose | Read by |
|---|---|---|
| `config/apps/<app>.yaml` | URLs, safety policy, budgets, per-app overrides — **CLI runs only** | `config/load.ts` |
| `config/lexicon.yaml` | Canonical label names (optional) | `config/load.ts` |
| `config/testdata.yaml` | Dummy values by label / by control kind (optional) | `config/load.ts` |
| `.env` | LLM API keys + optional model overrides — **AI Summary only** | `config/load.ts` |

- The **web UI never reads YAML** — `server/adhoc.ts` builds an `AppConfig` in-memory from pasted URLs.
- Dates support `today` and relative offsets (`+30d`, `-1m`, `+1y`), and ranges (`today..+30d`).
- Value-help fields intentionally have no dummy value — the engine opens the lookup and selects a real row.
- **Capture needs no API key at all.** `.env` affects only the AI Summary tab (§6.3); everything else runs offline.

```bash
# .env — all optional; omit entirely to run deterministic-only
GROQ_API_KEY=
GROQ_API_KEY_2=
GROQ_API_KEY_3=
GEMINI_API_KEY=
```

`.env` is gitignored — keys never travel with the repository.

---

## 15. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Document has few/no points, screenshots look empty | Application hadn't finished rendering — raise `budgets.appReadyTimeoutMs`, re-run |
| Page title in log is the launchpad's, not the app's | Same cause as above — a very slow host may need a larger budget |
| Branch skipped: "could not return to the branch point" | Reload didn't bring the entry dialog back — if the app doesn't re-present the chooser on reload, that branch can't be reached automatically |
| Web component control not discovered | Confirm it's a supported `ui5-*` tag; if nested in another shadow root, `walkShadowElements` still finds it — but only if the host is reachable from the light DOM |
| Picker doesn't open on a web component | `shadowPierceOrF4` falls back to F4 — confirm the focused element accepts it; a fully custom mechanism may need a new case in `open-overlay.ts` |
| Points appear that shouldn't, or vice versa | Use `excludeLabels` to drop a structurally-interactive control that isn't a meaningful point |
| A page's sidebar consumes the whole run touring unrelated content | Known open gap (§8.7) — not shell chrome, a genuine content-navigation scoping problem |
| **General Summary tab empty / says no summary was returned** | The server is running code older than the page. `index.html` is read from disk per request, but `jobs.ts`/`app.ts` live in the running process — **restart the server** |
| **AI Summary reads identically to General Summary** | The LLM path fell back to deterministic. Check the server log for the reason — usually no key set, or every provider failing |
| **AI Summary tab shows an error** | Read the message: `No LLM API keys configured` (set `.env`), or `All LLM providers failed:` followed by each provider's own error |
| `Groq 404: model ... does not exist` | The default model id was retired. Set `GROQ_MODEL` in `.env` to a currently-served model |
| `Gemini 429: prepayment credits are depleted` | The Gemini fallback key has no billing credit — either top it up or rely on Groq |
| AI Summary returns fewer points than expected | Points whose evidence citations failed validation were dropped on purpose (§6.2) — the capture may simply hold little documentable evidence |

---

## 16. Notes and Limits

- **Native `<select>`** renders its list in the OS layer, uncapturable — the engine sets a valid option and photographs the result.
- **Loop detection** fingerprints the UI5 control tree first, the URL second — Fiori commonly keeps one URL across many application states.
- **Budgets** (per-control timeout, page cap, depth cap, wall-clock cap) bound every run; any that triggers is recorded in `report.json`. `maxControlsPerPage` is **unset by default** — a page is explored fully regardless of control count.
- A control with **no resolvable label** is still filled (closing full-page capture shows a complete form) but produces no point of its own.
- Returning to a branch point **fully reloads** the application — a hash-only URL change is a same-document navigation and would leave a single-page app exactly where it is.
- Screenshot capture **retries once** after a short wait on CDP timeout — a transient failure no longer silently drops a point from the final document.
- **No Playwright, no Puppeteer, no CDP library dependency** — the automation layer speaks CDP directly over a WebSocket.
- **Control deduplication:** `dedupeKeyFor()` assigns a three-tier identity to controls: Tier 1 prefers UI5's application-authored id suffix (survives view renumbering), Tier 2 falls back to the full id, Tier 3 uses section+label. Identity audit (Q3 2026) confirmed this system correctly handles the observed SAP Fiori Elements application; audit artifacts and regression tests are preserved in version control for historical reference.
