// Same import-cycle break as the other BaseMlsService specs.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import { toBase64 } from '$lib/utils/hex';

/**
 * A PURGE EMPTIED THE SERVER AND LEFT THE DEVICE HOLDING THE WHOLE POOL.
 *
 * `republishKeyMaterial` deletes every published one-time prekey and mints up to fifty more, once
 * per 30 s during a `NoMatchingKeyPackage` storm. Publishing one writes a private bundle locally,
 * and nothing ever deleted one - so every round orphaned fifty bundles of ~2 364 bytes for the 84
 * days until their lifetimes elapsed. Measured on the Mi 9T on 2026-09-09:
 *
 *     load_or_create: state composition - 10676363B total; KeyPackage 3051x7214310B, ...
 *     load_or_create: key package census - 3051 proven (2782 one-time, 269 last-resort);
 *                     0 expired, 0 undecodable; 528 mint instant(s), largest batch 51
 *
 * 2782 one-time bundles against a pool of FIFTY - about fifty-six rounds - and not one byte of it
 * reclaimable that day, because the only prune that exists needs an elapsed lifetime.
 *
 * **THE SAFETY ARGUMENT IS ENTIRELY ABOUT WHERE THE LIST COMES FROM, which is what these assert.**
 * The delivery service DELETES a prekey row as it hands it out, so "the server no longer lists it"
 * cannot tell "a peer is about to send the Welcome built on it" from "its owner revoked it". A row
 * the PURGE deleted is unambiguous: it was still in the pool, and being in the pool is the same as
 * never having been handed out. So the device forgets exactly what the server reported deleting,
 * and may never work the set out for itself.
 */
const ONE = new Uint8Array([1, 2, 3]);
const TWO = new Uint8Array([4, 5, 6]);

function makeCtx(purged: string[]) {
  const forgetKeyPackages = vi.fn().mockResolvedValue(purged.length);
  const generateKeyPackage = vi.fn().mockResolvedValue(new Uint8Array());
  const deleteAllOneTimePrekeys = vi.fn().mockResolvedValue(purged);
  return {
    ctx: {
      lastKeyMaterialRepublish: 0,
      delivery: { deleteAllOneTimePrekeys },
      // The real implementation, so the base64 decode and the ordering are under test rather
      // than stubbed past.
      forgetPurgedPrekeys: (
        BaseMlsService.prototype as unknown as {
          forgetPurgedPrekeys(p: string[]): Promise<void>;
        }
      ).forgetPurgedPrekeys,
      forgetKeyPackages,
      generateKeyPackage,
    },
    forgetKeyPackages,
    generateKeyPackage,
    deleteAllOneTimePrekeys,
  };
}

const republish = (ctx: unknown): Promise<void> =>
  (
    BaseMlsService.prototype as unknown as {
      republishKeyMaterial(k: string): Promise<void>;
    }
  ).republishKeyMaterial.call(ctx, 'device-key');

describe('republishKeyMaterial completes the purge it starts', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('forgets exactly the bundles the server reported deleting', async () => {
    const { ctx, forgetKeyPackages, generateKeyPackage } = makeCtx([toBase64(ONE), toBase64(TWO)]);

    await republish(ctx);

    expect(forgetKeyPackages).toHaveBeenCalledTimes(1);
    const handed = forgetKeyPackages.mock.calls[0][0] as Uint8Array[];
    expect(handed.map((b) => Array.from(b))).toEqual([Array.from(ONE), Array.from(TWO)]);
    expect(generateKeyPackage).toHaveBeenCalledTimes(1);
  });

  it('forgets NOTHING when the purge reported nothing, because a failed purge returns an empty list', async () => {
    // `deleteAllOneTimePrekeys` swallowed its own failure until 2026-09-09 and returned `void`, so
    // a purge that never reached the server was indistinguishable from one that emptied the pool -
    // and the caller minted fifty more against a pool it had not cleared. An empty list is now what
    // a failure looks like, and it must reclaim nothing: the server still holds those prekeys, and
    // forgetting their private halves would strand every peer holding one.
    const { ctx, forgetKeyPackages, generateKeyPackage } = makeCtx([]);

    await republish(ctx);

    expect(forgetKeyPackages).not.toHaveBeenCalled();
    expect(generateKeyPackage).toHaveBeenCalledTimes(1);
  });

  it('still remints when forgetting fails, because reclaiming is maintenance and publishing is not', async () => {
    const { ctx, generateKeyPackage, forgetKeyPackages } = makeCtx([toBase64(ONE)]);
    forgetKeyPackages.mockRejectedValue(new Error('keystore busy'));

    await expect(republish(ctx)).resolves.toBeUndefined();
    expect(generateKeyPackage).toHaveBeenCalledTimes(1);
  });

  it('is still debounced, so a storm cannot turn the reclaim into its own load', async () => {
    const { ctx, deleteAllOneTimePrekeys } = makeCtx([toBase64(ONE)]);

    await republish(ctx);
    await republish(ctx);

    expect(deleteAllOneTimePrekeys).toHaveBeenCalledTimes(1);
  });
});
