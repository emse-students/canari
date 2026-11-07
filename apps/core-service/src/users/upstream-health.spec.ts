/// <reference types="jest" />

import { UpstreamHealth } from './upstream-health';

describe('UpstreamHealth - a dependency known to be down is not asked by every request', () => {
  let t = 1_000;
  const health = () => new UpstreamHealth(() => t);
  beforeEach(() => {
    t = 1_000;
  });

  it('asks freely while up, and the first failure is the one transition to down', () => {
    const h = health();
    expect(h.admit()).toBe('ask');
    expect(h.admit()).toBe('ask');
    expect(h.recordFailure()).toEqual({ since: 1_000 });
    expect(h.recordFailure()).toBeNull();
    expect(h.isDown()).toBe(true);
  });

  it('lets exactly one probe through while down and skips the rest, counting them', () => {
    const h = health();
    h.recordFailure();
    expect(h.admit()).toBe('probe');
    expect(h.admit()).toBe('skip');
    expect(h.admit()).toBe('skip');
    t = 5_000;
    expect(h.recordSuccess()).toEqual({ downForMs: 4_000, skipped: 2 });
    expect(h.isDown()).toBe(false);
    expect(h.admit()).toBe('ask');
  });

  it('a failed probe frees the slot so the next request probes, without a second transition', () => {
    const h = health();
    h.recordFailure();
    expect(h.admit()).toBe('probe');
    expect(h.recordFailure()).toBeNull();
    expect(h.admit()).toBe('probe');
  });

  it('a success that was never preceded by a failure is not a transition', () => {
    expect(health().recordSuccess()).toBeNull();
  });

  it('a late success of a request asked before the flip also clears the state', () => {
    const h = health();
    h.admit();
    h.admit();
    h.recordFailure();
    expect(h.recordSuccess()).not.toBeNull();
    expect(h.isDown()).toBe(false);
  });
});
