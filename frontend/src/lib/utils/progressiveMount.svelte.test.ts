/**
 * The feed mounts its first screen at once and the rest a couple of cards per animation frame
 * (see `progressiveMount.svelte.ts`). The frame is faked, so the order is the test's, never a clock's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { progressiveCount } from './progressiveMount.svelte';

const frames = new Map<number, () => void>();
let nextId = 0;

beforeEach(() => {
  frames.clear();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    frames.set(++nextId, cb);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Runs the pending frame, then lets the effect it triggers schedule the next one. */
function frame() {
  const [id, next] = [...frames][0] ?? [];
  if (id !== undefined) frames.delete(id);
  next?.();
  flushSync();
}

describe('progressiveCount', () => {
  it('mounts `initial` at once and `batch` more per frame until every item is there', () => {
    const cleanup = $effect.root(() => {
      const p = progressiveCount({ total: () => 7, resetKey: () => 'a', initial: 3, batch: 2 });
      flushSync();
      expect([p.count, p.complete]).toEqual([3, false]);
      frame();
      expect([p.count, p.complete]).toEqual([5, false]);
      frame();
      expect([p.count, p.complete]).toEqual([7, true]);
      expect(frames.size).toBe(0);
    });
    cleanup();
  });

  it('a list that fits in the first screen schedules no frame at all', () => {
    const cleanup = $effect.root(() => {
      const p = progressiveCount({ total: () => 2, resetKey: () => 'a', initial: 3, batch: 2 });
      flushSync();
      expect(p.complete).toBe(true);
      expect(frames.size).toBe(0);
    });
    cleanup();
  });

  it('a list that grows (the next page) continues from where it was, never unmounting', () => {
    let total = $state(3);
    const cleanup = $effect.root(() => {
      const p = progressiveCount({ total: () => total, resetKey: () => 'a', initial: 3, batch: 2 });
      flushSync();
      expect(p.complete).toBe(true);
      total = 8;
      flushSync();
      expect(p.count).toBe(3);
      frame();
      expect(p.count).toBe(5);
    });
    cleanup();
  });

  it('another list (a new key) starts over from the first screen', () => {
    let key = $state('a');
    const cleanup = $effect.root(() => {
      const p = progressiveCount({ total: () => 6, resetKey: () => key, initial: 3, batch: 3 });
      flushSync();
      frame();
      expect(p.complete).toBe(true);
      key = 'b';
      flushSync();
      expect(p.count).toBe(3);
      expect(p.complete).toBe(false);
    });
    cleanup();
  });
});
