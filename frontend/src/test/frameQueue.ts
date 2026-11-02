import { afterEach, beforeEach, vi } from 'vitest';

/**
 * A MANUAL ANIMATION-FRAME QUEUE for tests whose subject does its first read on the next frame
 * (`watchClampOverflow`): `requestAnimationFrame` only queues, and `flushFrames()` runs what is
 * queued, so "the box is measured one frame after it mounts" is a fact the test steps through
 * rather than a race with the DOM shim's timers. Call `useFrameQueue()` at the top of the file.
 */
const queue = new Map<number, FrameRequestCallback>();
let nextId = 1;

/** Runs every queued frame callback, once, in order (callbacks queued meanwhile wait for the next call). */
export function flushFrames(): void {
  const due = [...queue.entries()];
  queue.clear();
  for (const [, callback] of due) callback(0);
}

/** Installs the queue before each test and removes it after. */
export function useFrameQueue(): void {
  beforeEach(() => {
    queue.clear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextId++;
      queue.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => void queue.delete(id));
  });
  afterEach(() => {
    // Run what is left so a module that remembers its scheduled frame sees it fire.
    flushFrames();
    vi.unstubAllGlobals();
    queue.clear();
  });
}
