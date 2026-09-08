/**
 * Pure helper functions used by the Explorer state machine (explorer.ts).
 *
 * Kept apart from the Explorer class deliberately: unlike the class's own
 * methods, none of these touch instance state (`this.*`), so they are safe to
 * read, test, and change in isolation from the exploration state machine
 * itself.
 */

import type { ControlDescriptor, InteractionType } from '../types.js';
import { KIND_TO_INTERACTION, OPENS_OVERLAY } from '../types.js';

/**
 * Buttons that dismiss or confirm an overlay.
 *
 * These are never documentation points: they close the state being
 * photographed, and clicking them during normal processing would tear down a
 * dialog whose fields are still being filled.
 */
const DISMISS_LABELS = [
  'ok',
  'cancel',
  'close',
  'back',
  'apply',
  'done',
  'dismiss',
  'yes',
  'no',
];

export function isDismissLabel(label: string): boolean {
  const text = label.trim().toLowerCase().replace(/[.:]+$/, '');
  return DISMISS_LABELS.includes(text);
}

/**
 * The Fiori semantic object a URL's hash route targets — the part before the
 * first "-" in "#SemanticObject-action". Empty for a bare shell URL (the
 * launchpad home) or anything without a recognisable intent.
 */
export function semanticObjectOf(url: string): string {
  try {
    const u = new URL(url);
    const hash = decodeURIComponent(u.hash.replace(/^#/, ''));
    const route = hash.split('?')[0] ?? '';
    return route.split('-')[0] ?? '';
  } catch {
    return '';
  }
}

/** URL reduced to origin+path+hash-route, ignoring volatile query params. */
export function urlPath(url: string): string {
  try {
    const u = new URL(url);
    const hashRoute = u.hash.split('?')[0] ?? '';
    return `${u.origin}${u.pathname}${hashRoute}`;
  } catch {
    return url;
  }
}

/** Chooses the interaction type recorded for a control's evidence. */
export function interactionTypeFor(control: ControlDescriptor): InteractionType {
  if (OPENS_OVERLAY.has(control.kind)) {
    return KIND_TO_INTERACTION[control.kind] ?? 'dialogOpen';
  }
  return 'fill';
}

/** Guards against a handler hanging on an unresponsive control. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
