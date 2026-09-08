import type { Page } from '../automation/types.js';
import type { ControlDescriptor, ControlKind } from '../types.js';
import { POINT_KINDS } from '../types.js';
import type { AppConfig } from '../config/schema.js';
import { canonicalise, hasMeaningfulLabel, type LabelResolver } from './labels.js';
import { ADAPTERS } from './adapters/registry.js';
import { log } from '../util/logger.js';

/**
 * Turns raw probe output into typed `ControlDescriptor`s.
 *
 * Classification is a lookup, not an inference: each adapter maps its raw
 * control directly to a `ControlKind`, which in turn decides whether the
 * control earns a documentation point. Buttons are the sole exception —
 * whether a button reveals new UI can only be determined by clicking it, so
 * they are provisionally typed here and resolved later by the interaction
 * layer.
 *
 * This file knows nothing about any one technology — see
 * `adapters/registry.ts` for the ordered list it walks.
 */

/** Normalises a label for comparison and exclusion matching. */
function normalise(label: string): string {
  return label.trim().replace(/\s+/g, ' ').replace(/[:*]+$/, '').trim();
}

/**
 * Discovers every control on the current page by walking `ADAPTERS` in order.
 *
 * Elements already described by an earlier adapter are not re-added by a
 * later one, so each control yields exactly one descriptor.
 */
export async function discoverControls(
  page: Page,
  app: AppConfig,
  resolver: LabelResolver,
): Promise<ControlDescriptor[]> {
  const out: ControlDescriptor[] = [];
  const claimedDomIds = new Set<string>();
  const excluded = new Set(app.excludeLabels.map((l) => normalise(l).toLowerCase()));

  const foundByAdapter: number[] = [];
  let totalSkippedAsClaimed = 0;

  for (const adapter of ADAPTERS) {
    const isPresent = await adapter.detect(page);
    if (!isPresent) {
      foundByAdapter.push(0);
      continue;
    }

    const controls = await adapter.probe(page);
    const allowIdSuffixFallback = adapter.supportsIdSuffixFallback !== false;
    let found = 0;
    for (const c of controls) {
      // Skip anything an earlier adapter already described, including inner
      // elements of a control it claimed (whose ids are prefixed with the
      // control id).
      if (c.domId && claimedDomIds.has(c.domId)) {
        totalSkippedAsClaimed++;
        continue;
      }
      if (c.domId && [...claimedDomIds].some((id) => c.domId.startsWith(`${id}-`))) {
        totalSkippedAsClaimed++;
        continue;
      }
      if (!c.selector) continue;

      if (c.domId) claimedDomIds.add(c.domId);
      found++;

      const kind = adapter.classify(c);
      const container = adapter.containerType?.(c);

      const descriptor = makeDescriptor({
        id: c.id,
        kind,
        rawLabel: normalise(c.label || c.text),
        section: normalise(c.section),
        selector: c.selector,
        domOrder: c.domOrder,
        required: c.required,
        resolver,
        excluded,
        alreadyExpanded: c.alreadyExpanded,
        allowIdSuffixFallback,
        ...(c.inputType ? { inputType: c.inputType } : {}),
        ...(c.title ? { title: c.title } : {}),
        ...(container ? { containerType: container.type, containerLabel: normalise(container.label) } : {}),
      });

      out.push(descriptor);
    }
    foundByAdapter.push(found);
  }

  const byKind = new Map<ControlKind, number>();
  let pointCount = 0;
  for (const c of out) {
    byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
    if (c.isPoint) pointCount++;
  }
  const kindSummary = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind}:${n}`)
    .join(' ');
  log.debug(
    `  [discover] ${foundByAdapter.join('+')} (${totalSkippedAsClaimed} already claimed) ` +
      `total=${out.length} points=${pointCount} — ${kindSummary}`,
  );

  return out.sort((a, b) => a.domOrder - b.domOrder);
}

function makeDescriptor(args: {
  id: string;
  kind: ControlKind;
  rawLabel: string;
  section: string;
  selector: string;
  domOrder: number;
  required: boolean;
  resolver: LabelResolver;
  excluded: Set<string>;
  alreadyExpanded?: boolean;
  inputType?: string;
  title?: string;
  containerType?: ControlDescriptor['containerType'];
  containerLabel?: string;
  /** See `TechnologyAdapter.supportsIdSuffixFallback`. */
  allowIdSuffixFallback: boolean;
}): ControlDescriptor {
  const label = args.rawLabel;
  const canonicalLabel = canonicalise(label, args.resolver);
  const isExcluded =
    args.excluded.has(label.toLowerCase()) ||
    args.excluded.has(canonicalLabel.toLowerCase());

  /*
   * A control with no resolvable label cannot become a documentation point:
   * every point in the reference documents is identified by its label. Such a
   * control is still filled, so that the closing full-page capture shows a
   * complete form, but it contributes no screenshot of its own.
   */
  const hasLabel =
    hasMeaningfulLabel(canonicalLabel) || hasMeaningfulLabel(label);

  const fallbackSelector = args.allowIdSuffixFallback
    ? stableIdSelector(args.id)
    : undefined;

  const descriptor: ControlDescriptor = {
    id: args.id,
    dedupeKey: dedupeKeyFor(args.kind, label, canonicalLabel, args.section, args.id),
    kind: args.kind,
    label,
    canonicalLabel,
    selector: args.selector,
    ...(fallbackSelector ? { fallbackSelector } : {}),
    ...(args.inputType ? { inputType: args.inputType } : {}),
    domOrder: args.domOrder,
    required: args.required,
    isPoint: POINT_KINDS.has(args.kind) && !isExcluded && hasLabel,
  };
  if (args.alreadyExpanded) descriptor.alreadyExpanded = true;
  if (args.section) descriptor.section = args.section;
  if (args.title) descriptor.title = args.title;
  if (args.containerType) descriptor.containerType = args.containerType;
  if (args.containerLabel) descriptor.containerLabel = args.containerLabel;
  return descriptor;
}

/**
 * Builds the identity used to decide whether a control has already been
 * processed.
 *
 * Prefers the application-authored id suffix over the resolved label: a
 * control's label can legitimately read differently between two discovery
 * sweeps of the same physical element -- a real run selected a value-help
 * row and, on the very next sweep, that field's own control was rediscovered
 * with its label resolving to the code just selected ("A43578") instead of
 * "Contract Person Code". A label-keyed identity treats that as a brand-new,
 * never-before-seen control and documents it a second time under the wrong
 * name. The id suffix survives UI5 view renumbering (see `stableIdSuffix`)
 * and does not depend on label resolution at all, so the same field keeps
 * the same identity regardless of what its label happens to read at each
 * sweep.
 *
 * Next preference is the raw id, ahead of label+section -- confirmed needed
 * on a live capture: a personalization-dialog trigger button (an
 * application-authored id with no `--` view prefix, so the branch above does
 * not apply) is a framework-reused singleton re-attached under a *different*
 * enclosing Dialog each time it is invoked, so `sectionOf()` legitimately
 * returns a different title at each discovery even though it is the exact
 * same element both times. Keying by section+label treated that as two
 * distinct controls and queued the second one behind the first's own
 * side-effects, so it went stale before its turn came. A UI5 id is unique
 * across the whole application at any instant by construction (that is
 * exactly what `Element.registry` indexes on), so two discoveries reporting
 * the same id are always the same control, regardless of which container
 * happens to enclose it at each moment -- a strictly more reliable signal
 * than section, which only describes transient DOM ancestry. Falls back to
 * label+section only when there is no id at all to key on.
 */
function dedupeKeyFor(
  kind: ControlKind,
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
 * The application-authored part of a UI5 id -- the portion from `--` onward,
 * ignoring the auto-generated view-instance prefix.
 *
 * `__xmlview2--DueDateId-inner` yields `--DueDateId-inner`, which still
 * identifies the same field after UI5 renumbers the view to `__xmlview3`.
 * Returns undefined for ids with no view prefix (`SalesAreaDialog-cancel`,
 * already application-authored) or too short a suffix to identify anything.
 */
function stableIdSuffix(id: string): string | undefined {
  const marker = id.indexOf('--');
  if (marker <= 0) return undefined;

  const stable = id.slice(marker);
  if (stable.length < 4) return undefined;

  return stable;
}

/**
 * Builds an id-suffix CSS selector that ignores UI5's auto-generated view
 * prefix, so the selector keeps matching after a view renumber.
 */
function stableIdSelector(id: string): string | undefined {
  const stable = stableIdSuffix(id);
  if (!stable) return undefined;
  return `[id$="${stable.replace(/["\\]/g, '\\$&')}"]`;
}
