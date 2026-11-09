// @vitest-environment happy-dom
import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import { applyPin, isMessagePinned, pinnedMessageIds } from './pinStore.svelte';

/**
 * A conversation's register is created lazily, on its first read - and that first read is very often
 * a `$derived` (the pinned banner). A source created INSIDE a reaction is not tracked by it, so a
 * register born in a derived must still notify that derived of the first pin applied after it.
 */
describe('pin register reactivity', () => {
  it('a $derived that first read an unseen conversation sees the pin applied after it', () => {
    const seen: string[][] = [];
    const stop = $effect.root(() => {
      const ids = $derived(pinnedMessageIds('conv_fresh_ids'));
      $effect(() => {
        seen.push(ids);
      });
    });
    flushSync();
    applyPin('conv_fresh_ids', 'msg_1', true, 1);
    flushSync();
    stop();
    expect(seen).toEqual([[], ['msg_1']]);
  });

  it('a $derived on isMessagePinned for an unseen conversation follows a pin and an unpin', () => {
    const seen: boolean[] = [];
    const stop = $effect.root(() => {
      const pinned = $derived(isMessagePinned('conv_fresh_one', 'msg_1'));
      $effect(() => {
        seen.push(pinned);
      });
    });
    flushSync();
    applyPin('conv_fresh_one', 'msg_1', true, 1);
    flushSync();
    applyPin('conv_fresh_one', 'msg_1', false, 2);
    flushSync();
    stop();
    expect(seen).toEqual([false, true, false]);
  });
});
