/**
 * The card's preview load: each way it ends is a typed value, only an opened image is shown, and a
 * poster already opened is NEVER fetched again - only a new name reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveRefusalError } from './api';
import { LivePosterOpenError } from './livePosterCrypto';
import { forgetLivePostersExcept, loadLivePoster } from './livePosterView';
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
});
