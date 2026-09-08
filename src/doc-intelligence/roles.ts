import type { ControlKind } from '../types.js';
import type { ContainerType, ControlNode } from './model.js';

/**
 * Semantic roles, grounded in the six real captures behind the plan rather
 * than an assumed universal vocabulary. Kept small and closed — extend only
 * when a new capture shows a shape these don't cover.
 */
export type SemanticRole =
  | 'filter-field'
  | 'action-trigger'
  | 'reveal-trigger'
  | 'toggle'
  | 'value-entry'
  | 'navigation'
  | 'readonly-display'
  | 'unknown';

const BASE_ROLE: Readonly<Record<ControlKind, SemanticRole>> = {
  input: 'value-entry',
  textarea: 'value-entry',
  select: 'value-entry',
  date: 'value-entry',
  dateRange: 'value-entry',
  valueHelp: 'value-entry',
  multiSelect: 'value-entry',
  checkbox: 'toggle',
  radio: 'toggle',
  fileUpload: 'value-entry',
  revealButton: 'reveal-trigger',
  actionButton: 'action-trigger',
  tab: 'navigation',
  navItem: 'navigation',
  readonly: 'readonly-display',
  unknown: 'unknown',
};

/**
 * Derived only from kind + containerType + interactionKind, per the plan —
 * never section identity or label text, to avoid circularity with pattern
 * detection (which itself is built on these roles).
 */
export function inferRole(control: ControlNode, containerType: ContainerType | undefined): SemanticRole {
  const base = BASE_ROLE[control.kind] ?? 'unknown';

  if (containerType === 'toolbar' && base === 'action-trigger') {
    return 'action-trigger';
  }

  if (containerType === 'toolbar' && base === 'value-entry') {
    return 'filter-field';
  }

  if (containerType === 'table' && base === 'value-entry' && control.kind === 'select') {
    return 'filter-field';
  }

  return base;
}

/** Convenience wrapper for callers that keep a control-path -> containerType map. */
export function roleOf(
  control: ControlNode,
  containers: Map<string, ContainerType>,
): SemanticRole {
  const containerType = containers.get(control.path.join('/'));
  return inferRole(control, containerType);
}
