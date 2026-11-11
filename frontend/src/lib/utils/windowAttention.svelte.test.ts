// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import {
  ATTENTION_GESTURES,
  ATTENTION_WINDOW_MS,
  createAttentionSignal,
  isAttentiveAt,
  isPersonGesture,
} from './windowAttention.svelte';

/**
 * AN IDLE WEB WINDOW DOES NOT READ (owner, 2026-11-11). The signal's contract, and the shape of the
 * receipt effect that relies on it: an arrival while idle marks nothing, the first gesture after it
 * marks, an attended window marks as before, and native mobile is never asked.
 */

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** A stand-in for the receipt effect: it marks the newest arrival when the window is attended. */
function receiptBench(exempt = false) {
  const time = clock();
  const signal = createAttentionSignal(null, () => exempt, time.now);
  let arrivals = $state(0);
  const marks: number[] = [];
  const runs = { count: 0 };
  const stop = $effect.root(() => {
    $effect(() => {
      const newest = arrivals;
      runs.count += 1;
      if (newest === 0) return;
      if (!signal.attentive) return;
      if (marks.at(-1) !== newest) marks.push(newest);
    });
  });
  flushSync();
  return {
    time,
    signal,
    marks,
    runs,
    arrive: () => {
      arrivals += 1;
      flushSync();
    },
    stop,
  };
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

describe('the receipt effect over the attention signal', () => {
  it('marks nothing for a message that arrives after 2 min idle, then marks at the first gesture', () => {
    const bench = receiptBench();
    try {
      bench.signal.noteGesture();
      bench.time.advance(ATTENTION_WINDOW_MS + 1);
      const before = bench.runs.count;
      bench.arrive();
      expect(bench.marks).toEqual([]);
      // The threshold having elapsed ran nothing by itself.
      expect(bench.runs.count).toBe(before + 1);

      bench.time.advance(60_000);
      bench.signal.noteGesture();
      flushSync();
      expect(bench.marks).toEqual([1]);
    } finally {
      bench.stop();
    }
  });

  it('marks an arrival at once while the window is attended, as before', () => {
    const bench = receiptBench();
    try {
      bench.signal.noteGesture();
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
      bench.signal.noteGesture();
      flushSync();
      const before = bench.runs.count;
      bench.time.advance(10_000);
      bench.signal.noteGesture();
      flushSync();
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

describe('MainChatPage - the receipt effect asks the attention signal before any write', () => {
  it('checks windowAttention.attentive before the local mark, the owed mark and the send', () => {
    const source = readFileSync('src/lib/components/MainChatPage.svelte', 'utf8');
    const note = source.indexOf('readMarks.note(');
    const effectStart = source.lastIndexOf('$effect(() => {', note);
    const body = source.slice(effectStart, note);
    const gate = body.indexOf('if (!windowAttention.attentive) {');
    expect(gate).toBeGreaterThan(-1);
    for (const write of [
      'withOwnReadAdvanced(',
      'recordSalonReadMark(',
      'recordDmReadMark(',
      'publishConversationRead(',
    ]) {
      expect(body.indexOf(write)).toBeGreaterThan(gate);
    }
  });
});
