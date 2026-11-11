import { afterEach, describe, expect, it, vi } from 'vitest';

/** Every `follow-statuses` call: its ids, and the way to answer or fail it. */
const calls = vi.hoisted(
  () =>
    [] as {
      ids: string[];
      answer: (s: Record<string, unknown>) => void;
      fail: (e: unknown) => void;
    }[]
);
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  getFollowStatuses: (ids: string[]) =>
    new Promise((resolve, reject) => calls.push({ ids: [...ids], answer: resolve, fail: reject })),
}));

import { ensurePersonStatus, resetFollowState } from './followState.svelte';

/** Lets every queued microtask run, so a flush scheduled by `ensurePersonStatus` has happened. */
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('follow statuses - one round of calls in flight', () => {
  afterEach(async () => {
    // Settle what a test left out, so the in-flight count returns to zero for the next one.
    for (const call of calls.splice(0)) call.answer({});
    await turn();
    resetFollowState();
    vi.restoreAllMocks();
  });

  it('sends eight ticks of cards as two calls: the first, then everything queued meanwhile', async () => {
    // Eight cards mounting in eight separate turns, as a feed page does.
    for (let i = 0; i < 8; i++) {
      ensurePersonStatus(`u${i}`);
      await turn();
    }

    // Before: eight calls. Now: the first one is out, the other seven wait for its answer.
    expect(calls).toHaveLength(1);
    expect(calls[0].ids).toEqual(['u0']);

    calls[0].answer({ u0: 'following' });
    await turn();

    expect(calls).toHaveLength(2);
    expect(calls[1].ids).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']);
  });

  it('asks a person once, however many surfaces name it', async () => {
    ensurePersonStatus('a');
    ensurePersonStatus('a');
    await turn();
    ensurePersonStatus('a');
    await turn();

    expect(calls).toHaveLength(1);
    expect(calls[0].ids).toEqual(['a']);
  });

  it('keeps going after a failed call: the waiting ids leave, the failed one is not re-asked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ensurePersonStatus('x');
    await turn();
    ensurePersonStatus('y');
    ensurePersonStatus('x');
    await turn();
    expect(calls).toHaveLength(1);

    calls[0].fail(new Error('offline'));
    await turn();

    expect(calls).toHaveLength(2);
    expect(calls[1].ids).toEqual(['y']);
  });
});
