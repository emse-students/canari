/**
 * The card's preview load: each way it ends is a typed value, and only an opened image is shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveRefusalError } from './api';
import { LivePosterOpenError } from './livePosterCrypto';
import { loadLivePoster } from './livePosterView';
import { TransportFailureError } from '$lib/utils/transportFailure';

const LIVE = { id: 'l1', poster: { name: 'p1', ageMs: 3000 }, key: 'ab'.repeat(32) };

beforeEach(() => {
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

describe('loadLivePoster', () => {
  it('opens the named poster under the served key into a JPEG blob', async () => {
    const d = deps(async () => new ArrayBuffer(4));
    const outcome = await loadLivePoster(LIVE, undefined, d);
    expect(outcome.kind).toBe('shown');
    if (outcome.kind === 'shown') expect(outcome.image.type).toBe('image/jpeg');
    expect(d.fetch).toHaveBeenCalledWith('l1', 'p1', undefined);
    expect(d.open).toHaveBeenCalledWith(LIVE.key, 'l1', expect.any(Uint8Array));
  });

  it('asks nothing without a poster or a key', async () => {
    const d = deps(async () => new ArrayBuffer(4));
    await expect(loadLivePoster({ ...LIVE, poster: null }, undefined, d)).resolves.toEqual({
      kind: 'none',
    });
    await expect(loadLivePoster({ ...LIVE, key: null }, undefined, d)).resolves.toEqual({
      kind: 'none',
    });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('types a replaced object, no network, a seal that does not open, and an abort', async () => {
    const gone = deps(async () => {
      throw new LiveRefusalError(404, null, 'x', 'not-found', null, null, null);
    });
    await expect(loadLivePoster(LIVE, undefined, gone)).resolves.toEqual({ kind: 'gone' });
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
