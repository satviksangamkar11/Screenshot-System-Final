import type { ControlNode, SectionNode, UiDocumentationModel } from './model.js';
import { collectControls, collectSections } from './model.js';
import type { UiPattern } from './patterns.js';

/**
 * Deterministic documentation facts derived from a captured `UiDocumentationModel`
 * and its detected patterns. See "Facts and TL;DR selection" in
 * docs/ai-documentation-intelligence-plan.md — no LLM judgment here, only the
 * fixed relevance rules from that section.
 */
export interface DocFact {
  text: string;
  importance: 'high' | 'medium';
  category?: 'structure' | 'behavior' | 'state';
}

/** A section counts as "major structure" once it has a real name and more than one child node. */
function isMajorSection(section: SectionNode): boolean {
  if (!section.meaningfulLabel) return false;
  const childCount = section.containers.length + section.controls.length;
  return childCount > 1;
}

function isBranchOrDialogReveal(control: ControlNode): boolean {
  const isRevealKind = control.kind === 'revealButton' || control.interactionKind === 'dialogOpen';
  return isRevealKind && control.observedInteractionResult === 'ok';
}

function isMeaningfulInteractedControl(control: ControlNode): boolean {
  return control.state === 'interacted' && control.meaningfulLabel;
}

/**
 * Derives DocFacts from structural/pattern/interaction evidence only — same
 * model in, same facts out, no randomness and no AI calls.
 */
export function deriveFacts(model: UiDocumentationModel, patterns: UiPattern[]): DocFact[] {
  const facts: DocFact[] = [];

  // HIGH: major section structure.
  for (const section of collectSections(model.root)) {
    if (isMajorSection(section)) {
      const containerCount = section.containers.length;
      const controlCount = section.controls.length + section.containers.reduce((n, c) => n + c.controls.length, 0);
      facts.push({
        text: `Section "${section.canonicalLabel}" is a major structural section with ${containerCount} container(s) and ${controlCount} control(s).`,
        importance: 'high',
        category: 'structure',
      });
    }
  }

  // HIGH: strong recurring pattern (3+ occurrences). MEDIUM: 2-occurrence pattern.
  for (const pattern of patterns) {
    if (pattern.strength === 'strong') {
      facts.push({
        text: `Recurring pattern "${pattern.normalizedRoles.join(' > ')}" appears ${pattern.occurrences} times across the captured UI.`,
        importance: 'high',
        category: 'structure',
      });
    } else if (pattern.strength === 'medium') {
      facts.push({
        text: `Pattern "${pattern.normalizedRoles.join(' > ')}" appears twice in the captured UI.`,
        importance: 'medium',
        category: 'structure',
      });
    }
  }

  const controls = collectControls(model.root);

  // HIGH: branch/dialog reveal (a control that opens a dialog and did so successfully).
  for (const control of controls) {
    if (isBranchOrDialogReveal(control)) {
      const label = control.meaningfulLabel ? control.canonicalLabel : 'an unlabeled control';
      facts.push({
        text: `"${label}" opens a dialog/branch that was successfully revealed during capture.`,
        importance: 'high',
        category: 'behavior',
      });
    }
  }

  // HIGH: non-default observed state on a meaningful control.
  for (const control of controls) {
    if (isMeaningfulInteractedControl(control)) {
      facts.push({
        text: `"${control.canonicalLabel}" was observed in an interacted (non-default) state during capture.`,
        importance: 'high',
        category: 'state',
      });
    }
  }

  // MEDIUM: a single meaningful interaction — controls whose interactionKind is
  // non-default (deterministic engine behavior) but which were left at their
  // default runtime state, so they don't already qualify as a HIGH state fact.
  for (const control of controls) {
    if (
      control.state === 'default' &&
      control.meaningfulLabel &&
      control.interactionKind !== 'initialFullPage' &&
      control.interactionKind !== 'finalFullPage' &&
      !isBranchOrDialogReveal(control)
    ) {
      facts.push({
        text: `"${control.canonicalLabel}" supports a meaningful interaction (${control.interactionKind}).`,
        importance: 'medium',
        category: 'behavior',
      });
    }
  }

  return facts;
}
