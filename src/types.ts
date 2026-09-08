/**
 * Shared data model for the UI documentation engine.
 *
 * The two stages of the pipeline (capture -> assemble) communicate only through
 * the `RunTrace` structure, which is serialised to `trace.json`. Nothing in the
 * document stage may reach back into the browser.
 */

/** Which application version a run targets. */
export type VersionId = 'old' | 'new';

/**
 * Classification of a discovered UI control.
 *
 * The distinction that matters most is `revealButton` vs `actionButton`:
 * a reveal button opens new UI (dialog, popup, section, page) and therefore
 * earns a documentation point; an action button (Save/Search/Execute) merely
 * performs an action and earns none.
 */
export type ControlKind =
  | 'input'
  | 'textarea'
  | 'select'
  | 'date'
  | 'dateRange'
  | 'valueHelp'
  | 'multiSelect'
  | 'checkbox'
  | 'radio'
  | 'fileUpload'
  | 'revealButton'
  | 'actionButton'
  | 'tab'
  | 'navItem'
  | 'readonly'
  | 'unknown';

/**
 * The structural container a control sits inside — a form-like group, a
 * table, a toolbar or a dialog — when the adapter's technology exposes
 * enough structure to say so with confidence.
 *
 * Canonical home for this type: `doc-intelligence/model.ts`'s `ContainerNode`
 * consumes exactly this value (re-exported there, not redeclared), so a
 * container identity assigned here during discovery survives unchanged all
 * the way to the diff engine's container-matching logic.
 */
export type ContainerType = 'group' | 'table' | 'toolbar' | 'dialog';

/**
 * Control kinds that produce a documentation point (label + screenshot).
 *
 * Every control that opens meaningful UI, plus fillable controls whose
 * filled state matters for documentation. Action buttons, read-only fields,
 * tabs and nav items drive exploration but are never documented.
 */
export const POINT_KINDS: ReadonlySet<ControlKind> = new Set<ControlKind>([
  'input',
  'textarea',
  'select',
  'date',
  'dateRange',
  'valueHelp',
  'multiSelect',
  'checkbox',
  'radio',
  'fileUpload',
  'revealButton',
]);

/** Control kinds whose *opened* state is the evidence, not their filled state. */
export const OPENS_OVERLAY: ReadonlySet<ControlKind> = new Set<ControlKind>([
  'select',
  'date',
  'dateRange',
  'valueHelp',
  'multiSelect',
  'revealButton',
]);

/** Maps a control kind to the interaction type recorded for its evidence. */
export const KIND_TO_INTERACTION: Readonly<Record<string, InteractionType>> = {
  input: 'fill',
  textarea: 'fill',
  select: 'dropdownOpen',
  date: 'calendarOpen',
  dateRange: 'calendarOpen',
  valueHelp: 'valueHelpOpen',
  multiSelect: 'multiSelectOpen',
  revealButton: 'dialogOpen',
};

/** What a screenshot is evidence of. */
export type InteractionType =
  | 'initialFullPage'
  | 'dropdownOpen'
  | 'calendarOpen'
  | 'valueHelpOpen'
  | 'multiSelectOpen'
  | 'dialogOpen'
  | 'fill'
  | 'finalFullPage';

/** A control discovered on a page, before any interaction. */
export interface ControlDescriptor {
  /** Locator identity: how the control is found in the DOM right now. */
  id: string;
  /**
   * Stable identity across re-discovery.
   *
   * Selectors shift when a dialog opens or a section expands, so deduplication
   * keys on the control's meaning (kind + label + section) rather than its
   * position, which would otherwise cause the same field to be processed again
   * on every sweep.
   */
  dedupeKey: string;
  kind: ControlKind;
  /** Label as shown to the user. */
  label: string;
  /** Label after lexicon normalisation; used for Old/New convergence. */
  canonicalLabel: string;
  /** Enclosing fieldset/panel heading, e.g. "General", "Analysis Data". */
  section?: string;
  /**
   * Underlying input type for text-like controls (`number`, `email`, `tel`…).
   *
   * Needed because a numeric field rejects the default alphanumeric dummy
   * value outright, which surfaced as a wave of validation errors rather than
   * as a filled form.
   */
  inputType?: string;
  /** CSS selector, resolved via `page.locator()`. */
  selector: string;
  /**
   * Selector that survives UI5 view-id churn, tried when `selector` misses.
   *
   * UI5 gives views without an explicit id an auto-generated prefix from a
   * global counter — `__xmlview2--DueDateId`, `__xmlview2--BPGrpId`. That
   * prefix is assigned when the view instance is created, so re-instantiating
   * the view renumbers it (`__xmlview3--DueDateId`) and every id-based
   * selector captured beforehand silently matches nothing. The application's
   * own stable id is the part from `--` onward, so an ends-with match on that
   * still finds the control after a renumber.
   */
  fallbackSelector?: string;
  /** Position in document order; drives deterministic processing order. */
  domOrder: number;
  required: boolean;
  /** True when this control yields a documentation point. */
  isPoint: boolean;
  /**
   * True for a disclosure toggle (`aria-expanded`, `<summary>`) that is
   * currently open.
   *
   * Clicking one of these can only collapse content that is already visible —
   * there is nothing left for it to reveal. A real run clicked the header of
   * an already-expanded panel as an ordinary button, which closed it: the
   * panel's own 17 fields went invisible for the rest of the run (each
   * skipped as "not interactable (not visible)"), and the collapsed panel was
   * itself misrecorded as a `revealButton` documentation point because the
   * click did change the DOM — just not in the direction that matters. A
   * toggle that starts collapsed is unaffected and still gets clicked and
   * documented as before.
   */
  alreadyExpanded?: boolean;
  /**
   * The element's HTML `title` attribute, when discovery captured one.
   *
   * Exists because a control's meaningful text does not always live in its
   * visible label — an icon-only toolbar button carries its purpose only in
   * its tooltip. Any adapter may populate this; nothing here is specific to
   * one technology. See `interaction/safety.ts`'s `ExtraDenyCheck` for the
   * consumer this exists for.
   */
  title?: string;
  /**
   * The structural container this control sits inside (its nearest table,
   * form group, toolbar or dialog), when the owning adapter's `containerType`
   * hook could establish one with confidence. Absent, not guessed, when it
   * can't — see `TechnologyAdapter.containerType` in
   * `discovery/adapters/core/adapter.ts`.
   */
  containerType?: ContainerType;
  /** The container's own label (e.g. a table's header text), paired with `containerType`. */
  containerLabel?: string;
}

/** One captured piece of evidence: a label and its screenshot. */
export interface Evidence {
  seq: number;
  runId: string;
  version: VersionId;
  /** Human-readable path from the root, e.g. ['Root', 'Multiple order Search']. */
  workflowPath: string[];
  pageId: string;
  pageTitle: string;
  /**
   * The tab this evidence was captured under, e.g. "Form", "Copy",
   * "Attachments".
   *
   * A tab switch changes which controls are on screen but does not leave the
   * page, so tabs group content *within* a page rather than forming child
   * pages of their own — which is also how the reference documents present
   * them ("Form Section", "Copy Section", "Attachment Section", one closing
   * "Full Page" for the lot).
   */
  tab?: string;
  /** Enclosing fieldset heading within the tab, e.g. "General". */
  section?: string;
  /** The structural container this point's control sat inside; see `ControlDescriptor.containerType`. */
  containerType?: ContainerType;
  /** Paired with `containerType`; the container's own label, e.g. a table's header text. */
  containerLabel?: string;
  label: string;
  canonicalLabel: string;
  interactionType: InteractionType;
  /** Path relative to the run directory. */
  screenshotPath: string;
  /**
   * Further screenshots belonging to this same point, in order.
   *
   * A full-page capture of a long form is taken as a series of viewport-sized
   * scroll segments rather than one very tall image: the reference documents
   * do exactly this (their "Full Page" is twelve consecutive screenfuls), and
   * a single tall capture embedded at the document's fixed width renders as an
   * illegible strip.
   */
  additionalScreenshots?: string[];
  status: 'ok' | 'exception';
  error?: string;
  /** Control kind that produced this evidence; absent for full-page shots. */
  controlKind?: ControlKind;
}

/** A page encountered during exploration. */
export interface PageState {
  pageId: string;
  /** Fingerprint used for loop detection. */
  fingerprint: string;
  parentPageId?: string;
  url: string;
  title: string;
  workflowPath: string[];
  completed: boolean;
}

/** Anything that could not be automated, recorded rather than silently skipped. */
export interface ExceptionRecord {
  seq: number;
  pageId: string;
  workflowPath: string[];
  label: string;
  controlKind: ControlKind;
  action: string;
  message: string;
  screenshotPath?: string;
  at: string;
}

/**
 * A button the safety policy refused to click, recorded rather than silently
 * dropped — an icon-only toolbar button whose deny match came from its
 * `title` rather than its visible label is exactly the case that is easy to
 * lose track of otherwise.
 */
export interface SafetySkipRecord {
  seq: number;
  label: string;
  controlKind: ControlKind;
  reason: string;
  at: string;
}

/** Internal audit information for one version run. */
export interface ExecutionReport {
  runId: string;
  version: VersionId;
  appName: string;
  url: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  pagesVisited: number;
  controlsDiscovered: number;
  controlsProcessed: number;
  pointsCaptured: number;
  screenshotsCaptured: number;
  branchesExplored: number;
  exceptions: ExceptionRecord[];
  /** Buttons the safety policy refused to click. */
  safetySkipped: SafetySkipRecord[];
  /** Populated when a budget stopped exploration early. */
  budgetStops: string[];
}

/** The serialised contract between the capture and assembly stages. */
export interface RunTrace {
  runId: string;
  appName: string;
  version: VersionId;
  url: string;
  startedAt: string;
  finishedAt: string;
  pages: PageState[];
  evidence: Evidence[];
  report: ExecutionReport;
}
