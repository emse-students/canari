import { describe, expect, it, vi } from 'vitest';
import type { IMlsService } from '$lib/mls-client';
import { createMlsHolder } from './mlsHolder';

/**
 * The retirement chain is what `loginImpl` awaits before it opens any state, so it must SETTLE
 * whatever happens to the write or the destroy behind it: a rejection there left the login, and
 * `isLoginInProgress`, waiting on a chain that would never resolve again.
 */
function holderWith(destroy: () => void) {
  const made: IMlsService[] = [];
  const holder = createMlsHolder(() => {
    const client = { destroy: vi.fn(destroy) } as unknown as IMlsService;
    made.push(client);
    return client;
  });
  return { holder, made };
}

describe('createMlsHolder - a retirement always settles', () => {
  it('settles and stops retiring when the final write rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { holder, made } = holderWith(() => {});
    holder.ensure();
    await holder.retire(Promise.reject(new Error('disk full')));
    await expect(holder.whenRetired()).resolves.toBeUndefined();
    expect(holder.isRetiring()).toBe(false);
    expect(made[0].destroy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('settles and stops retiring when destroying the old client throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { holder } = holderWith(() => {
      throw new Error('worker already gone');
    });
    holder.ensure();
    await holder.retire(Promise.resolve());
    await expect(holder.whenRetired()).resolves.toBeUndefined();
    expect(holder.isRetiring()).toBe(false);
    vi.restoreAllMocks();
  });

  it('a second retirement before the first lands is waited for too', async () => {
    const { holder } = holderWith(() => {});
    let landFirst: () => void = () => {};
    holder.ensure();
    void holder.retire(new Promise<void>((r) => (landFirst = r)));
    holder.ensure();
    void holder.retire(Promise.resolve());
    let released = false;
    void holder.whenRetired().then(() => (released = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(released).toBe(false);
    expect(holder.isRetiring()).toBe(true);
    landFirst();
    await holder.whenRetired();
    expect(released).toBe(true);
    expect(holder.isRetiring()).toBe(false);
  });
});
