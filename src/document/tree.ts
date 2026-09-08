import type { Evidence } from '../types.js';

/**
 * Page hierarchy for document assembly.
 *
 * The explorer already records each piece of evidence with a `workflowPath` —
 * the chain of pages/branches from the application root down to where it was
 * captured (`['Root']`, `['Root', 'Organization']`, …). This module turns that
 * flat list back into a tree, so the document can render it as nested headings
 * (application → page → sub-page/dialog → interaction) instead of a flat
 * sequence of labels.
 */

export interface PageNode {
  /** Full path from the root, e.g. ['Root', 'Organization']. */
  path: string[];
  /** Display name — the path's last segment; empty for the root itself. */
  name: string;
  /** path.length - 1; 0 for the root node. */
  depthBeyondRoot: number;
  /** Evidence captured directly on this page, in capture order. */
  ownEvidence: Evidence[];
  /** Child pages/branches, ordered by when they were first entered. */
  children: PageNode[];
  /** Earliest sequence number under this node, used to order siblings. */
  firstSeq: number;
}

/**
 * Builds the page tree for one version's evidence.
 *
 * Every distinct `workflowPath` becomes a node. A path whose parent path has
 * no evidence of its own (for example an application that presents a chooser
 * dialog before anything else is documented) still gets an implicit, empty
 * parent node, so the tree stays connected down to a single root.
 */
export function buildPageTree(evidence: Evidence[]): PageNode {
  const byPathKey = new Map<string, PageNode>();

  const nodeFor = (path: string[]): PageNode => {
    const key = path.join('');
    let node = byPathKey.get(key);
    if (!node) {
      node = {
        path,
        name: path.length > 1 ? path[path.length - 1]! : '',
        depthBeyondRoot: path.length - 1,
        ownEvidence: [],
        children: [],
        firstSeq: Number.MAX_SAFE_INTEGER,
      };
      byPathKey.set(key, node);
    }
    return node;
  };

  const root = nodeFor(['Root']);

  for (const ev of [...evidence].sort((a, b) => a.seq - b.seq)) {
    const path = ev.workflowPath.length > 0 ? ev.workflowPath : ['Root'];
    const node = nodeFor(path);
    node.ownEvidence.push(ev);
    node.firstSeq = Math.min(node.firstSeq, ev.seq);

    // Ensure every ancestor exists and is linked, even if it has no evidence
    // of its own — this is what keeps a chooser-first application's tree
    // connected back to a single root.
    for (let i = path.length - 1; i > 0; i--) {
      const child = nodeFor(path.slice(0, i + 1));
      const parent = nodeFor(path.slice(0, i));
      if (!parent.children.includes(child)) {
        parent.children.push(child);
      }
      parent.firstSeq = Math.min(parent.firstSeq, child.firstSeq);
    }
  }

  sortChildren(root);
  return root;
}

function sortChildren(node: PageNode): void {
  node.children.sort((a, b) => a.firstSeq - b.firstSeq);
  for (const child of node.children) sortChildren(child);
}

/**
 * Validates that every node's evidence actually belongs under it and that the
 * tree has no orphaned or duplicated paths.
 *
 * Returns human-readable problems rather than throwing: a malformed trace
 * should still produce the best document it can, with the issue surfaced in
 * the execution report instead of aborting assembly.
 */
export function validatePageTree(root: PageNode): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  const walk = (node: PageNode, expectedParentPath: string[] | null): void => {
    const key = node.path.join('');
    if (seen.has(key)) {
      problems.push(`duplicate page node for path [${node.path.join(' → ')}]`);
    }
    seen.add(key);

    if (expectedParentPath) {
      const gotParent = node.path.slice(0, -1);
      if (gotParent.join('') !== expectedParentPath.join('')) {
        problems.push(
          `page [${node.path.join(' → ')}] is not a direct child of ` +
            `[${expectedParentPath.join(' → ')}]`,
        );
      }
    }

    for (const ev of node.ownEvidence) {
      const evPath = ev.workflowPath.length > 0 ? ev.workflowPath : ['Root'];
      if (evPath.join('') !== node.path.join('')) {
        problems.push(
          `evidence "${ev.label}" (seq ${ev.seq}) is attached to ` +
            `[${node.path.join(' → ')}] but its workflowPath is [${evPath.join(' → ')}]`,
        );
      }
    }

    for (const child of node.children) walk(child, node.path);
  };

  walk(root, null);
  return problems;
}
