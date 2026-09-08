import type { ContainerNode, SectionNode, UiDocumentationModel } from './model.js';
import { inferRole, type SemanticRole } from './roles.js';

export interface UiPattern {
  normalizedRoles: string[];
  occurrences: number;
  strength: 'strong' | 'medium' | 'none';
  sourceAdapters: string[];
  exampleSectionPaths: string[][];
}

interface ShapeInstance {
  roles: SemanticRole[];
  path: string[];
  sourceAdapter?: string;
}

/**
 * A pattern's shape key is (containerType | 'section-level') + the sorted
 * role multiset it contains. Sorting makes the key order-independent, so two
 * groups with the same roles in a different DOM order still match — order
 * within a container/section is not part of a pattern's identity.
 */
function shapeKey(scope: string, roles: SemanticRole[]): string {
  return `${scope}::${[...roles].sort().join(',')}`;
}

function collectContainerInstances(container: ContainerNode): ShapeInstance | null {
  if (container.controls.length === 0) return null;
  const roles = container.controls.map((c) => inferRole(c, container.containerType));
  return { roles, path: container.path, sourceAdapter: container.sourceAdapter };
}

function collectSectionInstances(section: SectionNode): ShapeInstance | null {
  if (section.controls.length === 0) return null;
  const roles = section.controls.map((c) => inferRole(c, undefined));
  return { roles, path: section.path, sourceAdapter: section.sourceAdapter };
}

/**
 * Occurrence count -> strength: 3+ = strong, 2 = medium. A single occurrence
 * is not a recurring pattern, so shapes seen exactly once are dropped from
 * the result entirely rather than returned with strength 'none'.
 */
export function detectPatterns(model: UiDocumentationModel): UiPattern[] {
  const groups = new Map<string, { scope: string; roles: SemanticRole[]; instances: ShapeInstance[] }>();

  const visitSection = (section: SectionNode) => {
    const sectionInstance = collectSectionInstances(section);
    if (sectionInstance) {
      const key = shapeKey('section-level', sectionInstance.roles);
      const existing = groups.get(key);
      if (existing) existing.instances.push(sectionInstance);
      else groups.set(key, { scope: 'section-level', roles: sectionInstance.roles, instances: [sectionInstance] });
    }

    for (const container of section.containers) {
      const containerInstance = collectContainerInstances(container);
      if (!containerInstance) continue;
      const key = shapeKey(container.containerType, containerInstance.roles);
      const existing = groups.get(key);
      if (existing) existing.instances.push(containerInstance);
      else groups.set(key, { scope: container.containerType, roles: containerInstance.roles, instances: [containerInstance] });
    }
  };

  const visitPage = (page: UiDocumentationModel['root']) => {
    for (const section of page.sections) visitSection(section);
    for (const child of page.children) visitPage(child);
  };
  visitPage(model.root);

  const patterns: UiPattern[] = [];
  for (const group of groups.values()) {
    const occurrences = group.instances.length;
    if (occurrences < 2) continue;

    const sourceAdapters = [...new Set(group.instances.map((i) => i.sourceAdapter).filter((a): a is string => !!a))].sort();

    patterns.push({
      normalizedRoles: [...group.roles].sort(),
      occurrences,
      strength: occurrences >= 3 ? 'strong' : 'medium',
      sourceAdapters,
      exampleSectionPaths: group.instances.map((i) => i.path),
    });
  }

  return patterns;
}
