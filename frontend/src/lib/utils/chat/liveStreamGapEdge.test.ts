import { describe, expect, it } from 'vitest';
import { createLiveStreamGapEdge } from './liveStreamGapEdge';

describe('createLiveStreamGapEdge', () => {
  it('lists nothing on the first connect of a session', () => {
    const edge = createLiveStreamGapEdge();
    expect(edge.observe(false, true)).toBe(false);
    expect(edge.observe(true, true)).toBe(false);
  });

  it('flags exactly one return per up -> down -> up', () => {
    const edge = createLiveStreamGapEdge();
    edge.observe(false, true);
    edge.observe(true, true);
    expect(edge.observe(false, true)).toBe(false);
    expect(edge.observe(true, true)).toBe(true);
    expect(edge.observe(true, true)).toBe(false);
  });

  it('treats the connect after a logout and login as a connect', () => {
    const edge = createLiveStreamGapEdge();
    edge.observe(false, true);
    edge.observe(true, true);
    edge.observe(false, false);
    expect(edge.observe(false, true)).toBe(false);
    expect(edge.observe(true, true)).toBe(false);
  });
});
