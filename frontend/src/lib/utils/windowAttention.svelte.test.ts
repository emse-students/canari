// @vitest-environment happy-dom
import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import {
  ATTENTION_GESTURES,
  ATTENTION_WINDOW_MS,
  createAttentionSignal,
  isAttentiveAt,
  isPersonGesture,
  windowReadVerdict,
} from './windowAttention.svelte';

/**
 * AN IDLE WEB WINDOW DOES NOT READ (owner, 2026-11-11). The signal, its listeners, and the verdict
 * the receipt effect takes from it: an arrival while idle marks nothing, the first gesture after it
 * marks, an attended window marks as before, and native mobile is never asked.
 */

/** A clock the test moves; nothing here reads the wall clock. */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** happy-dom marks every dispatched event untrusted, so the trust half is injected. */
const trustedEvents = new WeakSet<Event>();
function personEvent(type: string): Event {
  const event = new Event(type);
  trustedEvents.add(event);
  return event;
}
const isGestureHere = (event: Event) =>
  trustedEvents.has(event) && isPersonGesture({ type: event.type, isTrusted: true } as Event);

function signalOn(target: EventTarget | null, exempt = false) {
  const time = clock();
  const signal = createAttentionSignal({
    target,
    exempt: () => exempt,
    now: time.now,
    isGesture: isGestureHere,
  });
  return { time, signal };
}

/**
 * The receipt effect's decision over a live signal: an effect that follows the arrivals and the
 * window, takes `windowReadVerdict`, and marks on `reading`.
 */
function receiptBench(exempt = false) {
  const target = new EventTarget();
  const { time, signal } = signalOn(target, exempt);
  let arrivals = $state(0);
  const marks: number[] = [];
  const runs = { count: 0 };
  const stop = $effect.root(() => {
    $effect(() => {
      const newest = arrivals;
      runs.count += 1;
      const verdict = windowReadVerdict({
        focused: true,
        visible: true,
        foreground: true,
        attentive: signal.attentive,
      });
      if (newest === 0 || verdict !== 'reading') return;
      if (marks.at(-1) !== newest) marks.push(newest);
    });
  });
  flushSync();
  const gesture = (type = 'pointerdown') => {
    target.dispatchEvent(personEvent(type));
    flushSync();
  };
  const arrive = () => {
    arrivals += 1;
    flushSync();
  };
  return { time, signal, marks, runs, gesture, arrive, stop };
}

describe('isAttentiveAt', () => {
  it('needs a gesture, and one within the window', () => {
    expect(isAttentiveAt(null, 5)).toBe(false);
    expect(isAttentiveAt(0, ATTENTION_WINDOW_MS - 1)).toBe(true);
    expect(isAttentiveAt(0, ATTENTION_WINDOW_MS)).toBe(false);
  });
});

describe('isPersonGesture', () => {
  it('refuses a scripted event and a pointermove that did not move', () => {
    expect(isPersonGesture(new Event('keydown'))).toBe(false);
    const still = { type: 'pointermove', isTrusted: true, movementX: 0, movementY: 0 };
    const moved = { type: 'pointermove', isTrusted: true, movementX: 3, movementY: 0 };
    expect(isPersonGesture(still as unknown as Event)).toBe(false);
    expect(isPersonGesture(moved as unknown as Event)).toBe(true);
    expect(isPersonGesture({ type: 'wheel', isTrusted: true } as unknown as Event)).toBe(true);
  });

  it('does not listen to scroll, which the app itself causes when a message lands', () => {
    expect(ATTENTION_GESTURES as readonly string[]).not.toContain('scroll');
  });
});

describe('the listeners', () => {
  it.each(['pointerdown', 'keydown', 'wheel', 'touchstart'])(
    'a person %s on the window makes it attended',
    (type) => {
      const target = new EventTarget();
      const { signal } = signalOn(target);
      expect(signal.attentive).toBe(false);
      target.dispatchEvent(personEvent(type));
      expect(signal.attentive).toBe(true);
      signal.destroy();
    }
  );

  it('a scripted event does not, nor a gesture type it does not listen to', () => {
    const target = new EventTarget();
    const { signal } = signalOn(target);
    target.dispatchEvent(new Event('keydown'));
    target.dispatchEvent(personEvent('scroll'));
    expect(signal.attentive).toBe(false);
    signal.destroy();
  });

  it('stops listening once destroyed, and reset makes the window idle again', () => {
    const target = new EventTarget();
    const { signal } = signalOn(target);
    target.dispatchEvent(personEvent('keydown'));
    signal.reset();
    expect(signal.attentive).toBe(false);
    signal.destroy();
    target.dispatchEvent(personEvent('keydown'));
    expect(signal.attentive).toBe(false);
  });
});

describe('windowReadVerdict', () => {
  it.each([
    [{ focused: false, visible: true, foreground: true, attentive: true }, 'away'],
    [{ focused: true, visible: false, foreground: true, attentive: true }, 'away'],
    [{ focused: true, visible: true, foreground: false, attentive: true }, 'away'],
    [{ focused: true, visible: true, foreground: true, attentive: false }, 'idle'],
    [{ focused: true, visible: true, foreground: true, attentive: true }, 'reading'],
  ] as const)('%o -> %s', (w, verdict) => {
    expect(windowReadVerdict(w)).toBe(verdict);
  });
});

describe('the receipt effect over the attention signal', () => {
  it('marks nothing for a message that arrives after 2 min idle, then marks at the first gesture', () => {
    const bench = receiptBench();
    try {
      bench.gesture();
      bench.time.advance(ATTENTION_WINDOW_MS + 1);
      const before = bench.runs.count;
      bench.arrive();
      expect(bench.marks).toEqual([]);
      // The threshold having elapsed ran nothing by itself: only the arrival did.
      expect(bench.runs.count).toBe(before + 1);

      bench.time.advance(60_000);
      bench.gesture('keydown');
      expect(bench.marks).toEqual([1]);
    } finally {
      bench.stop();
    }
  });

  it('marks an arrival at once while the window is attended, as before', () => {
    const bench = receiptBench();
    try {
      bench.gesture('wheel');
      bench.time.advance(30_000);
      bench.arrive();
      expect(bench.marks).toEqual([1]);
    } finally {
      bench.stop();
    }
  });

  it('re-runs nothing for a gesture while already attended', () => {
    const bench = receiptBench();
    try {
      bench.gesture();
      const before = bench.runs.count;
      bench.time.advance(10_000);
      bench.gesture();
      expect(bench.runs.count).toBe(before);
    } finally {
      bench.stop();
    }
  });

  it('on native mobile, marks with no gesture at all - the rule there is unchanged', () => {
    const bench = receiptBench(true);
    try {
      bench.time.advance(10 * ATTENTION_WINDOW_MS);
      bench.arrive();
      expect(bench.marks).toEqual([1]);
    } finally {
      bench.stop();
    }
  });
});
