import { describe, expect, it, vi } from 'vitest';
import type { IMlsService } from '$lib/mls-client';
import type { NativeMlsSessionEnd } from '$lib/utils/nativeMlsSession';
import { createMlsHolder } from './mlsHolder';
import { flushMacrotask } from '../../../test/flush';

/**
 * The retirement chain is what `loginImpl` awaits before it opens any state, so it must SETTLE
 * whatever happens to the write or the destroy behind it: a rejection there left the login, and
 * `isLoginInProgress`, waiting on a chain that would never resolve again.
 */
function holderWith(
  destroy: () => void,
  endNative: (reason: NativeMlsSessionEnd) => Promise<void> = async () => {}
) {
  const made: IMlsService[] = [];
  const ended = vi.fn(endNative);
  const holder = createMlsHolder(() => {
    const client = { destroy: vi.fn(destroy) } as unknown as IMlsService;
    made.push(client);
    return client;
  }, ended);
  return { holder, made, ended };
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
    await flushMacrotask();
    expect(released).toBe(false);
    expect(holder.isRetiring()).toBe(true);
    landFirst();
    await holder.whenRetired();
    expect(released).toBe(true);
    expect(holder.isRetiring()).toBe(false);
  });
});

describe('createMlsHolder - a reset that names its client', () => {
  it('destroys only the named client, never one built after it was retired', () => {
    const { holder, made } = holderWith(() => {});
    const stopped = holder.ensure();
    // A sign-out retires the stopped login's client, and the next sign-in builds its own.
    void holder.retire(new Promise<void>(() => {}));
    const next = holder.ensure();
    holder.reset(stopped);
    expect(holder.ensure()).toBe(next);
    expect(made[1].destroy).not.toHaveBeenCalled();
    // Named and still held: destroyed, and the next caller builds a fresh one.
    holder.reset(next);
    expect(made[1].destroy).toHaveBeenCalledTimes(1);
    expect(holder.ensure()).not.toBe(next);
  });
});

/**
 * THE NATIVE SESSION ENDS WITH THE CLIENT. The native manager is process-wide: destroying the
 * TypeScript client of account A left A's manager and at-rest key installed into account B's
 * sign-in. Every sign-out, account switch and stopped or failed login goes through these two exits.
 */
describe('createMlsHolder - the native MLS session ends with the client', () => {
  it('a sign-out ends it after the final write and the destroy, never before', async () => {
    const order: string[] = [];
    const { holder } = holderWith(
      () => order.push('destroy'),
      async (reason) => {
        order.push(`end native (${reason})`);
      }
    );
    holder.ensure();
    let land: () => void = () => {};
    const done = holder.retire(
      new Promise<void>((r) => (land = r)).then(() => {
        order.push('final write');
      })
    );
    await flushMacrotask();
    expect(order).toEqual([]);
    land();
    await done;
    expect(order).toEqual(['final write', 'destroy', 'end native (sign-out)']);
  });

  it('the next sign-in waits for it: whenRetired settles only once the native session ended', async () => {
    let endIt: () => void = () => {};
    const { holder } = holderWith(
      () => {},
      () => new Promise<void>((r) => (endIt = r))
    );
    holder.ensure();
    void holder.retire(Promise.resolve());
    let released = false;
    void holder.whenRetired().then(() => (released = true));
    await flushMacrotask();
    expect(released).toBe(false);
    endIt();
    await holder.whenRetired();
    expect(released).toBe(true);
  });

  it('a reset ends it at once, and the next sign-in waits for that too', async () => {
    let endIt: () => void = () => {};
    const { holder, ended } = holderWith(
      () => {},
      () => new Promise<void>((r) => (endIt = r))
    );
    holder.ensure();
    holder.reset();
    expect(ended).toHaveBeenCalledWith('client reset');
    let released = false;
    void holder.whenRetired().then(() => (released = true));
    await flushMacrotask();
    expect(released).toBe(false);
    endIt();
    await holder.whenRetired();
    expect(released).toBe(true);
  });

  it("a stopped login's reset ends it only while its client is still the current one", () => {
    const { holder, ended } = holderWith(() => {});
    const stopped = holder.ensure();
    void holder.retire(new Promise<void>(() => {}));
    holder.ensure();
    // The next sign-in's client is current: its native session is not the stopped login's to end.
    holder.reset(stopped);
    expect(ended).not.toHaveBeenCalled();
    const own = holder.ensure();
    holder.reset(own);
    expect(ended).toHaveBeenCalledWith('stopped login');
  });

  it('a teardown that fails is said and never strands the next sign-in', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { holder } = holderWith(
      () => {},
      async () => {
        throw new Error('teardown refused');
      }
    );
    holder.ensure();
    await holder.retire(Promise.resolve());
    holder.reset();
    await expect(holder.whenRetired()).resolves.toBeUndefined();
    expect(holder.isRetiring()).toBe(false);
    expect(error).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
