/**
 * Generic-DOM-semantics coverage for the overlay-settlement primitives.
 *
 * These test pure functions only (`isVisibleMeasurement`,
 * `nextStableNotBusyCount`) — no browser, no SAPUI5. The bug that motivated
 * both was found via a live SAPUI5 dialog, but the fix and these tests are
 * about generic DOM/CSSOM visibility rules and a generic poll-stabilization
 * counter; nothing here references any SAP class name, control, or app.
 *
 * Run:  npx tsx --test src/interaction/__tests__/overlay.test.ts
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  isVisibleMeasurement,
  nextStableNotBusyCount,
  STABLE_NOT_BUSY_THRESHOLD,
} from '../overlay.js';

/** A fully visible, unremarkable element — the default every test starts from and overrides. */
function visibleEl() {
  return { width: 100, height: 20, visibility: 'visible', display: 'block', opacity: '1', pointerEvents: 'auto' };
}

describe('isVisibleMeasurement', () => {
  it('a visible busy indicator reads as visible (busy)', () => {
    assert.equal(isVisibleMeasurement(visibleEl()), true);
  });

  it('visibility:hidden with a non-zero bounding box reads as NOT visible', () => {
    // The exact shape that exposed the bug: the element keeps its layout box
    // (non-zero width/height) while CSS hides it from view.
    assert.equal(
      isVisibleMeasurement({ ...visibleEl(), width: 320, height: 40, visibility: 'hidden' }),
      false,
    );
  });

  it('display:none reads as NOT visible', () => {
    assert.equal(isVisibleMeasurement({ ...visibleEl(), display: 'none' }), false);
  });

  it('opacity:0 reads as NOT visible', () => {
    assert.equal(isVisibleMeasurement({ ...visibleEl(), opacity: '0' }), false);
  });

  it('pointer-events:none reads as NOT visible', () => {
    assert.equal(isVisibleMeasurement({ ...visibleEl(), pointerEvents: 'none' }), false);
  });

  it('a zero-size element reads as NOT visible regardless of other styling', () => {
    assert.equal(isVisibleMeasurement({ ...visibleEl(), width: 0 }), false);
    assert.equal(isVisibleMeasurement({ ...visibleEl(), height: 0 }), false);
  });

  it('a normal, unhidden element reads as visible', () => {
    assert.equal(isVisibleMeasurement(visibleEl()), true);
  });
});

describe('nextStableNotBusyCount + STABLE_NOT_BUSY_THRESHOLD', () => {
  it('two consecutive not-busy polls reach the settled threshold', () => {
    let count = 0;
    count = nextStableNotBusyCount(count, false); // poll 1: not busy
    assert.ok(count < STABLE_NOT_BUSY_THRESHOLD, 'must not settle after only one not-busy poll');
    count = nextStableNotBusyCount(count, false); // poll 2: not busy
    assert.ok(count >= STABLE_NOT_BUSY_THRESHOLD, 'must settle once two consecutive not-busy polls are observed');
  });

  it('a busy poll resets the counter to zero', () => {
    let count = nextStableNotBusyCount(0, false);
    count = nextStableNotBusyCount(count, false);
    assert.ok(count >= STABLE_NOT_BUSY_THRESHOLD); // settled after 2 not-busy

    // Busy reappears (e.g. a progressive re-render kicking off a second fetch).
    count = nextStableNotBusyCount(count, true);
    assert.equal(count, 0, 'a busy observation must zero the counter even after it had settled');
  });

  it('busy → not-busy → busy → not-busy → not-busy settles only after the final two consecutive not-busy polls', () => {
    let count = 0;
    const sequence: Array<{ busy: boolean; expectSettled: boolean }> = [
      { busy: true, expectSettled: false },
      { busy: false, expectSettled: false }, // one not-busy poll: not yet settled
      { busy: true, expectSettled: false }, // busy again: resets, still not settled
      { busy: false, expectSettled: false }, // first not-busy after the reset
      { busy: false, expectSettled: true }, // second consecutive not-busy: now settled
    ];

    for (const step of sequence) {
      count = nextStableNotBusyCount(count, step.busy);
      assert.equal(
        count >= STABLE_NOT_BUSY_THRESHOLD,
        step.expectSettled,
        `busy=${step.busy} step produced count=${count}, expected settled=${step.expectSettled}`,
      );
    }
  });
});
