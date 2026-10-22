// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import { DeviceTrustRefusedError, type KeyPackageVerdict } from '$lib/mls-client/deviceTrust';

/**
 * A KeyPackage is checked against the device it was fetched for, and device keys are pinned on first
 * sight - the decision is Rust's (`device_trust.rs`, tested in `tests/device_binding.rs`). What is
 * tested here is the seam: `addMember` asks BEFORE it stages, turns a refusal into a TYPE, and every
 * Add carries the identity each package was fetched for down to the platform.
 */
type Proto = {
  addMember: (
    g: string,
    d: { keyPackage: Uint8Array; userId: string; deviceId: string },
    exclude?: string[]
  ) => Promise<unknown>;
  addMembersBulk: (
    g: string,
    d: Array<{ keyPackage: Uint8Array; userId: string; deviceId: string }>,
    exclude?: string[]
  ) => Promise<unknown>;
  vetKeyPackage: (kp: Uint8Array, u: string, d: string) => Promise<KeyPackageVerdict>;
};
const proto = BaseMlsService.prototype as unknown as Proto;

function makeCtx(verdict: KeyPackageVerdict) {
  const staged = {
    commit: new Uint8Array([1]),
    welcome: new Uint8Array([2]),
    groupInfo: new Uint8Array([3]),
    addedIndices: [0],
    skipped: [],
  };
  return {
    vetKeyPackage: proto.vetKeyPackage,
    vetKeyPackageNative: vi.fn(async () => verdict),
    stageAddMembers: vi.fn(async () => staged),
    exportRatchetTree: vi.fn(async () => new Uint8Array([4])),
    // Runs the stage function and hands back what the real transaction would after a merge.
    runCommitTransaction: vi.fn(async (_g: string, stage: () => Promise<typeof staged>) => {
      const s = await stage();
      return { welcome: s.welcome, ratchetTree: new Uint8Array([4]), addedDeviceIds: [] };
    }),
  };
}

const device = { keyPackage: new Uint8Array([9]), userId: 'Bob', deviceId: 'web-1' };

describe('BaseMlsService.addMember - the device a package was fetched for', () => {
  it('refuses a package naming another device with a typed error, staging nothing', async () => {
    const ctx = makeCtx('identity-mismatch');

    const outcome = proto.addMember.call(ctx, 'g1', device, ['Bob:web-1']);

    await expect(outcome).rejects.toBeInstanceOf(DeviceTrustRefusedError);
    await expect(outcome).rejects.toMatchObject({
      reason: 'identity-mismatch',
      userId: 'Bob',
      deviceId: 'web-1',
    });
    expect(ctx.vetKeyPackageNative).toHaveBeenCalledWith(device.keyPackage, 'Bob:web-1');
    expect(ctx.runCommitTransaction).not.toHaveBeenCalled();
    expect(ctx.stageAddMembers).not.toHaveBeenCalled();
  });

  it('refuses a changed signature key with the same type', async () => {
    const ctx = makeCtx('signature-key-changed');

    await expect(proto.addMember.call(ctx, 'g1', device)).rejects.toMatchObject({
      reason: 'signature-key-changed',
    });
    expect(ctx.stageAddMembers).not.toHaveBeenCalled();
  });

  it('stages a pinned device with its identity alongside the package', async () => {
    const ctx = makeCtx('pinned');

    await proto.addMember.call(ctx, 'g1', device, ['Bob:web-1']);

    expect(ctx.stageAddMembers).toHaveBeenCalledWith('g1', [
      { keyPackage: device.keyPackage, identity: 'Bob:web-1' },
    ]);
  });

  // NOT A TRUST QUESTION, SO NOT A TRUST ERROR: an expired package keeps reaching the Add, which
  // skips it with its own typed reason exactly as before.
  it('lets a package refused for another reason reach the Add unchanged', async () => {
    const ctx = makeCtx('expired');

    await proto.addMember.call(ctx, 'g1', device);

    expect(ctx.stageAddMembers).toHaveBeenCalledTimes(1);
  });
});

describe('BaseMlsService.addMembersBulk - every package travels with its identity', () => {
  it('pairs each package with the userId:deviceId it was fetched for, in order', async () => {
    const ctx = makeCtx('pinned');
    const other = { keyPackage: new Uint8Array([8]), userId: 'carol', deviceId: 'ios-2' };

    await proto.addMembersBulk.call(ctx, 'g1', [device, other]);

    expect(ctx.stageAddMembers).toHaveBeenCalledWith('g1', [
      { keyPackage: device.keyPackage, identity: 'Bob:web-1' },
      { keyPackage: other.keyPackage, identity: 'carol:ios-2' },
    ]);
  });
});

// THE ONE SOURCE OF A KEY THIS DEVICE HAS SEEN: the pins, read from the MLS layer and handed back
// unchanged - a device never seen is `null` (unverified), never an empty list a verifier could read
// as "no key matches, so forged".
describe('BaseMlsService.pinnedSignatureKeys - the pins, nothing else', () => {
  const pinned = (
    BaseMlsService.prototype as unknown as {
      pinnedSignatureKeys: (u: string, d: string) => Promise<Uint8Array[] | null>;
    }
  ).pinnedSignatureKeys;

  it('hands back the keys the MLS layer pinned for exactly that device', async () => {
    const key = new Uint8Array([1, 2, 3]);
    const ctx = { pinnedSignatureKeysNative: vi.fn(async () => [key]) };
    await expect(pinned.call(ctx, 'Bob', 'web-1')).resolves.toEqual([key]);
    expect(ctx.pinnedSignatureKeysNative).toHaveBeenCalledWith('Bob', 'web-1');
  });

  it('answers null for a device never seen, and says it is unverified', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const ctx = { pinnedSignatureKeysNative: vi.fn(async () => null) };
    await expect(pinned.call(ctx, 'Bob', 'web-2')).resolves.toBeNull();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('unverified'));
    debug.mockRestore();
  });
});

// The departures are Rust's record (tests/device_binding.rs); the seam hands them back unchanged.
describe('BaseMlsService.removalEpochs - the departures the MLS layer recorded', () => {
  it('asks for exactly that group and user and returns the epochs as recorded', async () => {
    const removal = (
      BaseMlsService.prototype as unknown as {
        removalEpochs: (g: string, u: string) => Promise<number[]>;
      }
    ).removalEpochs;
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const ctx = { removalEpochsNative: vi.fn(async () => [3, 7]) };
    await expect(removal.call(ctx, 'g1', 'Bob')).resolves.toEqual([3, 7]);
    expect(ctx.removalEpochsNative).toHaveBeenCalledWith('g1', 'Bob');
    debug.mockRestore();
  });
});
