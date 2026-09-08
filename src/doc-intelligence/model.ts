import type { ContainerType, ControlKind, Evidence, InteractionType, VersionId } from '../types.js';

/**
 * Shared data model for the deterministic documentation-intelligence pipeline.
 *
 * See `docs/ai-documentation-intelligence-plan.md`. This model is built from
 * already-captured `RunTrace` evidence — never from pixels — so every fact it
 * carries is something the browser engine already established.
 *
 * v1 scope: built from `Evidence` (what the capture pipeline actually
 * persists today — one entry per documentation point plus the full-page
 * captures). The plan's "every control, not just POINT_KINDS" ambition needs
 * the capture side to also persist the full `ControlDescriptor` list into
 * `RunTrace`, which is a separate, not-yet-done capture-layer change; nothing
 * here should assume that data exists.
 */

/** A node can be structurally real without being documentable by name. */
export interface LabelInfo {
  rawLabel: string;
  canonicalLabel: string;
  /** False for a bad label (".", punctuation-only, a bare dismiss-icon "X"). */
  meaningfulLabel: boolean;
}

export type NodeKind = 'page' | 'section' | 'container' | 'control';

/** Canonical definition lives in `types.ts`; re-exported so existing `model.js` importers are unaffected. */
export type { ContainerType };

export interface DocNodeBase extends LabelInfo {
  nodeKind: NodeKind;
  /** Deterministic identity used for matching; see `matchKey()` in matching.ts. */
  path: string[];
  order?: number;
  sourceAdapter?: string;
  evidenceRefs: number[];
}

export interface ControlNode extends DocNodeBase {
  nodeKind: 'control';
  kind: ControlKind;
  interactionKind: InteractionType;
  observedInteractionResult?: 'ok' | 'exception';
  state: 'default' | 'interacted';
}

export interface ContainerNode extends DocNodeBase {
  nodeKind: 'container';
  containerType: ContainerType;
  controls: ControlNode[];
}

export interface SectionNode extends DocNodeBase {
  nodeKind: 'section';
  containers: ContainerNode[];
  /** Controls directly in the section, outside any container. */
  controls: ControlNode[];
}

export interface PageDocNode extends DocNodeBase {
  nodeKind: 'page';
  sections: SectionNode[];
  children: PageDocNode[];
}

export interface UiDocumentationModel {
  version: VersionId;
  runId: string;
  root: PageDocNode;
}

/** All control nodes in a page subtree, depth-first. */
export function collectControls(node: PageDocNode): ControlNode[] {
  const out: ControlNode[] = [];
  const visitSection = (s: SectionNode) => {
    out.push(...s.controls);
    for (const c of s.containers) out.push(...c.controls);
  };
  const visitPage = (p: PageDocNode) => {
    for (const s of p.sections) visitSection(s);
    for (const child of p.children) visitPage(child);
  };
  visitPage(node);
  return out;
}

/** All section nodes in a page subtree, depth-first, page included implicitly via children. */
export function collectSections(node: PageDocNode): SectionNode[] {
  const out: SectionNode[] = [];
  const visitPage = (p: PageDocNode) => {
    out.push(...p.sections);
    for (const child of p.children) visitPage(child);
  };
  visitPage(node);
  return out;
}

export function anonymousLabel(kind: NodeKind): string {
  switch (kind) {
    case 'section':
      return 'anonymous-section';
    case 'container':
      return 'anonymous-container';
    case 'control':
      return 'anonymous-control';
    default:
      return 'anonymous-page';
  }
}

export { type Evidence };
