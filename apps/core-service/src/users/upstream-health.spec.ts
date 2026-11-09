/// <reference types="jest" />

import { MAX_PROBE_GAP, UpstreamHealth, classifyUpstreamFailure } from './upstream-health';

describe('UpstreamHealth - a dependency known to be down is not asked by every request', () => {
  let t = 1_000;
  const health = () => new UpstreamHealth(() => t);
  beforeEach(() => {
    t = 1_000;
  });

  it('asks freely while up, and the first failure is the one transition to down', () => {
    const h = health();
    const a = h.admit();
    expect(a).toBe('ask');
    expect(h.admit()).toBe('ask');
    expect(h.recordFailure(a)).toEqual({ since: 1_000 });
    expect(h.recordFailure('ask')).toBeNull();
    expect(h.isDown()).toBe(true);
  });

  it('spaces probes by a count of skipped requests: 1, 2, 4 ... then the cap, never a clock', () => {
    const h = health();
    h.recordFailure('ask');
    const probesAt: number[] = [];
    for (let i = 1; i <= 400; i += 1) {
      const a = h.admit();
      if (a === 'probe') {
        probesAt.push(i);
        h.recordFailure(a);
      }
    }
    // Skips between probes: 1, 2, 4, 8, 16, 32, 64, 64 ...
    expect(probesAt.slice(0, 7)).toEqual([2, 5, 10, 19, 36, 69, 134]);
    expect(probesAt[8] - probesAt[7]).toBe(MAX_PROBE_GAP + 1);
  });

  it('a late failure of an `ask` admitted before the flip does not free the probe slot', () => {
    const h = health();
    const ask1 = h.admit();
    const ask2 = h.admit();
    h.recordFailure(ask1); // flips down
    h.admit(); // skip (gap 1)
    expect(h.admit()).toBe('probe');
    expect(h.recordFailure(ask2)).toBeNull(); // the late one
    // the real probe is still in flight: nobody else may probe, however many skips pass
    for (let i = 0; i < 200; i += 1) expect(h.admit()).toBe('skip');
  });

  it('a late success of an `ask` clears the outage and resets the gap', () => {
    const h = health();
    const ask1 = h.admit();
    const ask2 = h.admit();
    h.recordFailure(ask1);
    t = 4_000;
    expect(h.recordSuccess(ask2)).toEqual({ downForMs: 3_000, skipped: 0 });
    expect(h.isDown()).toBe(false);
    expect(h.admit()).toBe('ask');
  });

  it('counts the requests answered from the state when it comes back', () => {
    const h = health();
    h.recordFailure('ask');
    h.admit();
    const probe = h.admit();
    expect(probe).toBe('probe');
    h.admit();
    expect(h.recordSuccess(probe)).toMatchObject({ skipped: 2 });
  });

  it('a local fault frees a probe slot and flips nothing', () => {
    const h = health();
    h.recordFailure('ask');
    h.admit();
    const probe = h.admit();
    h.release(probe);
    expect(h.isDown()).toBe(true);
    h.admit(); // gap is now 2 and the count restarted
    h.admit();
    expect(h.admit()).toBe('probe');
  });

  it('a success that was never preceded by a failure is not a transition', () => {
    expect(health().recordSuccess('ask')).toBeNull();
  });
});

describe('classifyUpstreamFailure - one classifier for every path', () => {
  it.each([[undefined], [502], [503], [504], [520], [530]])('%s proves an outage', (s) => {
    expect(classifyUpstreamFailure(true, s)).toBe('outage');
  });
  it.each([[400], [404], [410], [429], [500], [301], [401], [403]])('%s is an answer', (s) => {
    expect(classifyUpstreamFailure(true, s)).toBe('answer');
  });
  it('a local exception is never an outage', () => {
    expect(classifyUpstreamFailure(false, undefined)).toBe('local');
  });
});
