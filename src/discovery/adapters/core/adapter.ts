import type { Page } from '../../../automation/types.js';
import type { ContainerType, ControlKind } from '../../../types.js';

/**
 * Common shape every adapter's `probe()` must produce.
 *
 * `discoverControls()` builds a `ControlDescriptor` from these fields alone,
 * so an adapter is free to carry whatever technology-specific data it needs
 * internally (for its own `classify()`) as long as the raw control it hands
 * back also satisfies this contract.
 */
export interface RawControl {
  /** Application-level identity, used for the descriptor id and dedupe key. */
  id: string;
  /** Live DOM id, if any — used to prevent a later adapter re-describing the same element. */
  domId: string;
  /** CSS selector that re-resolves this element. */
  selector: string;
  label: string;
  text: string;
  section: string;
  domOrder: number;
  required: boolean;
  alreadyExpanded: boolean;
  /** Underlying <input> type, for text-like controls (number, email, tel...). */
  inputType?: string;
  /**
   * The element's HTML `title` attribute, when the adapter captured one.
   * See `ControlDescriptor.title`.
   */
  title?: string;
}

/**
 * A pluggable source of controls for one UI technology.
 *
 * `discoverControls()` walks an ordered list of these: each is asked whether
 * its technology is present, then (if so) to enumerate and classify its
 * controls. Adding support for a new technology means adding one adapter to
 * that list, not touching the classifier.
 */
export interface TechnologyAdapter<T extends RawControl = RawControl> {
  /** Is this technology running on the page? */
  detect(page: Page): Promise<boolean>;
  /** Enumerate this technology's controls in document order. */
  probe(page: Page): Promise<T[]>;
  /** Map one raw control to its documentation kind. */
  classify(control: T): ControlKind;
  /**
   * Whether `discoverControls()` should also compute the UI5-style
   * view-id-suffix fallback selector (`[id$="..."]`, see
   * `classifier.ts`'s `stableIdSelector`) for controls this adapter
   * produces.
   *
   * Defaults to `true` when omitted. That fallback exists to survive UI5's
   * auto-generated view-instance prefix being renumbered between
   * discovery and interaction — a concern specific to ids shaped like
   * `__xmlview2--SomeId`. An adapter whose ids are already session-stable
   * end-to-end (e.g. Web Dynpro ABAP's `WD01`, `WD02`, ...) has nothing to
   * gain from it, and an ends-with match on such a short, densely-reused id
   * risks matching an unrelated element entirely, so it opts out explicitly
   * rather than silently inheriting a fallback built for a different
   * framework's id scheme.
   */
  supportsIdSuffixFallback?: boolean;
  /**
   * An additional identity signal for loop detection and reveal-vs-action
   * button classification, layered on top of the generic DOM fingerprint
   * every page already gets (see `discovery/fingerprint.ts`).
   *
   * Most technologies render enough through native tags and ARIA roles that
   * the generic DOM fingerprint already captures a meaningful state change
   * (see `aria-dom.ts`'s `domFingerprint`); an adapter only needs this when
   * its framework can change state without changing what native markup is
   * visible — UI5's control tree is the motivating case. Omit when the
   * generic signal already suffices.
   */
  fingerprint?(page: Page): Promise<string>;
  /**
   * The structural container a control belongs to, when the adapter's
   * technology exposes enough structure to say so with confidence.
   *
   * Used for grouping in documentation output and, per the spec's container
   * identity rule (`type + parent path + label if available + structural
   * signature`, no positional component), for matching containers across
   * captures the same way controls are matched. Return `undefined` when the
   * adapter can't establish a container for a given control — a container is
   * never invented; an absent answer is preferred over a guessed one.
   *
   * The label accompanies the type because container *identity* (used for
   * matching two captures' containers against each other) is `type + label`,
   * not type alone — two tables in the same section are different containers
   * only distinguishable by their own headings. An empty label is valid: it
   * means this adapter found a container of this type but no title for it,
   * which the doc-intelligence layer treats as anonymous rather than merging
   * it with an unrelated same-type container that also has no title.
   */
  containerType?(control: T): { type: ContainerType; label: string } | undefined;
  /**
   * Whether this adapter's sibling order is a meaningful signal (e.g. a
   * technology that guarantees stable, semantically ordered document
   * structure) rather than an accident of DOM emission order.
   *
   * Defaults to `false`/omitted, meaning order carries no weight: controls
   * and containers are compared as multisets (identity by type + label +
   * structural signature, no positional/occurrence pairing of duplicates) —
   * see the plan's control multiset comparison rule. An adapter opts in only
   * when it can vouch that order reflects real structure, not incidental
   * rendering sequence.
   */
  ordersAreMeaningful?: boolean;
}
