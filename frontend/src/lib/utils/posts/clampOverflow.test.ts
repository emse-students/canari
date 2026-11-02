// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { flushFrames, useFrameQueue } from '../../../test/frameQueue';
import { watchClampOverflow } from './clampOverflow';

useFrameQueue();

/** A box whose `scrollHeight` is counted, so a read is an observable event. */
function box(scroll: number, client: number) {
  const el = document.createElement('div');
  const reads = vi.fn(() => scroll);
  Object.defineProperty(el, 'scrollHeight', { get: reads });
  Object.defineProperty(el, 'clientHeight', { get: () => client });
  return { el, reads };
}

describe('watchClampOverflow - the first read is one batched pass on the next frame', () => {
  it('reads nothing while mounting, then answers on the frame', () => {
    const { el, reads } = box(500, 100);
    const seen: boolean[] = [];
    watchClampOverflow(el, (o) => seen.push(o));
    expect(reads).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    flushFrames();
    expect(seen).toEqual([true]);
  });

  it('reads every box that asked in the same frame together, in one frame callback', () => {
    const a = box(500, 100);
    const b = box(100, 100);
    const seen: string[] = [];
    watchClampOverflow(a.el, (o) => seen.push(`a:${o}`));
    watchClampOverflow(b.el, (o) => seen.push(`b:${o}`));
    flushFrames(); // ONE flush answers both: they shared a single scheduled frame.
    expect(seen).toEqual(['a:true', 'b:false']);
  });

  it('a teardown before the frame cancels the read', () => {
    const { el, reads } = box(500, 100);
    const seen: boolean[] = [];
    const stop = watchClampOverflow(el, (o) => seen.push(o));
    stop();
    flushFrames();
    expect(reads).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});
