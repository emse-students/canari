/**
 * The card's preview load: each way it ends is a typed value, only an opened image is shown, and a
 * poster already opened is NEVER fetched again - only a new name reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveRefusalError } from './api';
import { LivePosterOpenError } from './livePosterCrypto';
import { forgetLivePostersExcept, LIVE_POSTER_MEMO_MAX, loadLivePoster } from './livePosterView';
import { LIVE_POSTER_MAX_CONCURRENT } from './constants';
import { TransportFailureError } from '$lib/utils/transportFailure';

const LIVE = { id: 'l1', poster: { name: 'p1', ageMs: 3000 }, posterKey: 'ab'.repeat(32) };

beforeEach(() => {
  forgetLivePostersExcept([]);
  for (const level of ['debug', 'log', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});
afterEach(() => vi.restoreAllMocks());

const deps = (
  fetchImpl: () => Promise<ArrayBuffer>,
  openImpl = async () => new Uint8Array([1, 2])
) => ({
  fetch: vi.fn(fetchImpl),
  open: vi.fn(openImpl),
});

const refusal = (status: number, kind: 'not-found' | 'rate-limited') =>
  new LiveRefusalError(status, null, 'x', kind, null, null, null);

describe('loadLivePoster', () => {
  it('opens the named poster under the served POSTER key into a JPEG blob', async () => {
    const d = deps(async () => new ArrayBuffer(4));
    const outcome = await loadLivePoster(LIVE, undefined, d);
    expect(outcome.kind).toBe('shown');
    if (outcome.kind === 'shown') expect(outcome.image.type).toBe('image/jpeg');
    expect(d.fetch).toHaveBeenCalledWith('l1', 'p1', undefined);
    expect(d.open).toHaveBeenCalledWith(LIVE.posterKey, 'l1', expect.any(Uint8Array));
  });

  it('fetches a poster ONCE: the same name again asks the network nothing, a new one does', async () => {
    const d = deps(async () => new ArrayBuffer(4));
    await loadLivePoster(LIVE, undefined, d);
    await expect(loadLivePoster({ ...LIVE }, undefined, d)).resolves.toMatchObject({
      kind: 'shown',
    });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    await loadLivePoster({ ...LIVE, poster: { name: 'p2', ageMs: 1000 } }, undefined, d);
    expect(d.fetch).toHaveBeenCalledTimes(2);
    // A live no longer listed is forgotten: listed again later, its poster is fetched anew.
    forgetLivePostersExcept(['other']);
    await loadLivePoster({ ...LIVE, poster: { name: 'p2', ageMs: 1000 } }, undefined, d);
    expect(d.fetch).toHaveBeenCalledTimes(3);
  });

  it('joins a load of the same name already RUNNING: two cards at once make one fetch', async () => {
    let give!: (b: ArrayBuffer) => void;
    const d = deps(() => new Promise<ArrayBuffer>((r) => (give = r)));
    const first = loadLivePoster(LIVE, undefined, d);
    const second = loadLivePoster({ ...LIVE }, undefined, d);
    give(new ArrayBuffer(4));
    const [a, b] = await Promise.all([first, second]);
    expect(a.kind).toBe('shown');
    expect(b).toEqual(a);
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('a joiner still wanting the poster loads its own when the load it joined was aborted', async () => {
    const abort = new AbortController();
    let fail!: (e: unknown) => void;
    const d = deps(async () => new ArrayBuffer(4));
    d.fetch.mockImplementationOnce(() => new Promise<ArrayBuffer>((_r, j) => (fail = j)));
    const first = loadLivePoster(LIVE, abort.signal, d);
    const second = loadLivePoster({ ...LIVE }, undefined, d);
    abort.abort();
    fail(new DOMException('aborted', 'AbortError'));
    await expect(first).resolves.toEqual({ kind: 'aborted' });
    await expect(second).resolves.toMatchObject({ kind: 'shown' });
    expect(d.fetch).toHaveBeenCalledTimes(2);
  });

  it('asks nothing without a poster or a key', async () => {
    const d = deps(async () => new ArrayBuffer(4));
    await expect(loadLivePoster({ ...LIVE, poster: null }, undefined, d)).resolves.toEqual({
      kind: 'none',
    });
    await expect(loadLivePoster({ ...LIVE, posterKey: null }, undefined, d)).resolves.toEqual({
      kind: 'none',
    });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('types a replaced object, the preview budget, no network, a bad seal and an abort', async () => {
    const gone = deps(async () => {
      throw refusal(404, 'not-found');
    });
    await expect(loadLivePoster(LIVE, undefined, gone)).resolves.toEqual({ kind: 'gone' });
    const limited = deps(async () => {
      throw refusal(429, 'rate-limited');
    });
    await expect(loadLivePoster(LIVE, undefined, limited)).resolves.toEqual({
      kind: 'rate-limited',
    });
    const offline = deps(async () => {
      throw new TransportFailureError(new TypeError('x'));
    });
    await expect(loadLivePoster(LIVE, undefined, offline)).resolves.toEqual({ kind: 'offline' });
    const bad = deps(
      async () => new ArrayBuffer(40),
      async () => {
        throw new LivePosterOpenError('unauthentic', 40);
      }
    );
    await expect(loadLivePoster(LIVE, undefined, bad)).resolves.toEqual({ kind: 'failed' });
    const abort = new AbortController();
    abort.abort();
    const aborted = deps(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(loadLivePoster(LIVE, abort.signal, aborted)).resolves.toEqual({ kind: 'aborted' });
  });

  it('holds at most LIVE_POSTER_MEMO_MAX images, the least recently used going first', async () => {
    const d = deps(async () => new ArrayBuffer(4));
    const live = (i: number) => ({ ...LIVE, id: `l${i}` });
    for (let i = 0; i < LIVE_POSTER_MEMO_MAX; i++) await loadLivePoster(live(i), undefined, d);
    // l0 is used again, so l1 is now the oldest.
    await loadLivePoster(live(0), undefined, d);
    await loadLivePoster(live(LIVE_POSTER_MEMO_MAX), undefined, d);
    expect(d.fetch).toHaveBeenCalledTimes(LIVE_POSTER_MEMO_MAX + 1);
    await loadLivePoster(live(0), undefined, d);
    expect(d.fetch).toHaveBeenCalledTimes(LIVE_POSTER_MEMO_MAX + 1);
    await loadLivePoster(live(1), undefined, d);
    expect(d.fetch).toHaveBeenCalledTimes(LIVE_POSTER_MEMO_MAX + 2);
  });
});

describe('loadLivePoster - the width of the fetches (S14)', () => {
  const lives = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `w${i}`,
      poster: { name: `n${i}`, ageMs: 1 },
      posterKey: 'ab'.repeat(32),
    }));

  it('never has more than LIVE_POSTER_MAX_CONCURRENT fetches out, and drains all of them', async () => {
    forgetLivePostersExcept([]);
    let out = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const d = deps(async () => {
      out++;
      peak = Math.max(peak, out);
      await new Promise<void>((r) => gates.push(r));
      out--;
      return new ArrayBuffer(2);
    });
    const loads = lives(10).map((l) => loadLivePoster(l, undefined, d));
    await Promise.resolve();
    // ten asked, three out: the rest wait for a slot, no clock involved
    expect(d.fetch).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
      while (gates.length) gates.shift()!();
    }
    const outcomes = await Promise.all(loads);
    expect(outcomes.every((o) => o.kind === 'shown')).toBe(true);
    expect(d.fetch).toHaveBeenCalledTimes(10);
    expect(peak).toBe(3);
  });

  it('frees the slot when a fetch fails, and an abort while waiting never fetches', async () => {
    forgetLivePostersExcept([]);
    const gates: Array<() => void> = [];
    const d = deps(async () => {
      await new Promise<void>((r) => gates.push(r));
      throw refusal(429, 'rate-limited');
    });
    const [a, b, c, e, f] = lives(5);
    const running = [a, b, c].map((l) => loadLivePoster(l, undefined, d));
    const ctl = new AbortController();
    const waitingAborted = loadLivePoster(e, ctl.signal, d);
    const waitingKept = loadLivePoster(f, undefined, d);
    await Promise.resolve();
    ctl.abort();
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
      while (gates.length) gates.shift()!();
    }
    expect((await waitingAborted).kind).toBe('aborted');
    expect((await waitingKept).kind).toBe('rate-limited');
    expect((await Promise.all(running)).map((o) => o.kind)).toEqual(Array(3).fill('rate-limited'));
    expect(d.fetch).toHaveBeenCalledTimes(4);
    // every slot is back: a new load starts at once
    const again = deps(async () => new ArrayBuffer(2));
    await expect(loadLivePoster(lives(1)[0], undefined, again)).resolves.toMatchObject({
      kind: 'shown',
    });
  });

  it('refuses at once a load whose signal is already aborted, even with every slot taken', async () => {
    forgetLivePostersExcept([]);
    const gates: Array<() => void> = [];
    const d = deps(async () => {
      await new Promise<void>((r) => gates.push(r));
      return new ArrayBuffer(2);
    });
    const all = lives(LIVE_POSTER_MAX_CONCURRENT + 2);
    const running = all
      .slice(0, LIVE_POSTER_MAX_CONCURRENT)
      .map((l) => loadLivePoster(l, undefined, d));
    await Promise.resolve();
    const ctl = new AbortController();
    ctl.abort();
    // no slot is free, and no `abort` event will ever fire: it must not queue
    await expect(loadLivePoster(all[LIVE_POSTER_MAX_CONCURRENT], ctl.signal, d)).resolves.toEqual({
      kind: 'aborted',
    });
    expect(d.fetch).toHaveBeenCalledTimes(LIVE_POSTER_MAX_CONCURRENT);
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
      while (gates.length) gates.shift()!();
    }
    await Promise.all(running);
    // nothing leaked: a new load starts at once
    const again = deps(async () => new ArrayBuffer(2));
    await expect(loadLivePoster(lives(1)[0], undefined, again)).resolves.toMatchObject({
      kind: 'shown',
    });
  });

  it('hands a freed slot to the longest waiter, never to a newcomer', async () => {
    forgetLivePostersExcept([]);
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const d = deps(async () => {
      await new Promise<void>((r) => gates.push(r));
      return new ArrayBuffer(2);
    });
    const orderedFetch = vi.fn(async (id: string) => {
      order.push(id);
      await new Promise<void>((r) => gates.push(r));
      return new ArrayBuffer(2);
    });
    const tracked = { ...d, fetch: orderedFetch };
    const all = lives(LIVE_POSTER_MAX_CONCURRENT + 2);
    const loads = all.map((l) => loadLivePoster(l, undefined, tracked));
    await Promise.resolve();
    expect(order).toEqual(all.slice(0, LIVE_POSTER_MAX_CONCURRENT).map((l) => l.id));
    // one slot frees; a newcomer arrives in the same turn, behind two waiters
    gates.shift()!();
    const newcomer = { ...lives(1)[0], id: 'newcomer', poster: { name: 'nn', ageMs: 1 } };
    loads.push(loadLivePoster(newcomer, undefined, tracked));
    for (let i = 0; i < 80; i++) {
      await Promise.resolve();
      while (gates.length) gates.shift()!();
    }
    await Promise.all(loads);
    expect(order.slice(LIVE_POSTER_MAX_CONCURRENT)).toEqual([
      all[LIVE_POSTER_MAX_CONCURRENT].id,
      all[LIVE_POSTER_MAX_CONCURRENT + 1].id,
      'newcomer',
    ]);
  });
});
