// @vitest-environment happy-dom
/**
 * `whenBecomesTrue`: the publish queue's wake on the `/api/version` capability fires when the answer
 * CHANGES to true, never on a reassignment of the same answer - the focus probe reassigns it every
 * time (review of #3061).
 */
import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import { whenBecomesTrue } from './whenBecomesTrue.svelte';

describe('whenBecomesTrue', () => {
  it('fires once per change to true, never on a reassignment of the same answer', () => {
    const state = $state({ check: { publishQueue: false as boolean | null } });
    let fired = 0;
    const stop = whenBecomesTrue(
      () => state.check.publishQueue === true,
      () => (fired += 1)
    );
    flushSync();
    expect(fired).toBe(0);

    state.check = { publishQueue: null };
    flushSync();
    expect(fired).toBe(0);

    state.check = { publishQueue: true };
    flushSync();
    expect(fired).toBe(1);

    // Every focus reassigns the answer: the same `true` again must not start another pass.
    state.check = { publishQueue: true };
    state.check = { publishQueue: true };
    flushSync();
    expect(fired).toBe(1);

    state.check = { publishQueue: false };
    flushSync();
    state.check = { publishQueue: true };
    flushSync();
    expect(fired).toBe(2);

    stop();
    state.check = { publishQueue: false };
    flushSync();
    state.check = { publishQueue: true };
    flushSync();
    expect(fired).toBe(2);
  });

  it('fires at once when the answer is already true', () => {
    let fired = 0;
    const stop = whenBecomesTrue(
      () => true,
      () => (fired += 1)
    );
    flushSync();
    expect(fired).toBe(1);
    stop();
  });
});
