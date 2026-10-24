// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import {
  DeviceTrustRefusedError,
  type DevicePin,
  type KeyPackageVerdict,
} from '$lib/mls-client/deviceTrust';

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

/** The intent the transaction hands its stage, which the platform records with the commit. */
const INTENT = new Uint8Array([7]);

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
    handOverDeviceEvents: vi.fn(async () => {}),
    // Runs the stage function and hands back what the real transaction would after a merge.
    runCommitTransaction: vi.fn(
      async (_g: string, stage: (intent: Uint8Array) => Promise<typeof staged>) => {
        const s = await stage(INTENT);
        return { welcome: s.welcome, ratchetTree: new Uint8Array([4]), addedDeviceIds: [] };
      }
    ),
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

    expect(ctx.stageAddMembers).toHaveBeenCalledWith(
      'g1',
      [{ keyPackage: device.keyPackage, identity: 'Bob:web-1' }],
      INTENT
    );
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

    expect(ctx.stageAddMembers).toHaveBeenCalledWith(
      'g1',
      [
        { keyPackage: device.keyPackage, identity: 'Bob:web-1' },
        { keyPackage: other.keyPackage, identity: 'carol:ios-2' },
      ],
      INTENT
    );
  });
});

// THE ONE SOURCE OF A KEY THIS DEVICE HAS SEEN: the pin, read from the MLS layer and handed back
// unchanged - a device never seen is `null` (unverified), never an empty list a verifier could read
// as "no key matches, so forged"; and a pin re-learned after its identity was pruned says so.
describe('BaseMlsService.pinnedSignatureKeys - the pins, nothing else', () => {
  const pinned = (
    BaseMlsService.prototype as unknown as {
      pinnedSignatureKeys: (u: string, d: string) => Promise<DevicePin | null>;
    }
  ).pinnedSignatureKeys;

  it('hands back the pin the MLS layer holds for exactly that device, anchoring included', async () => {
    const pin: DevicePin = {
      keys: [new Uint8Array([1, 2, 3])],
      anchored: false,
      reaffirmations: 2,
    };
    const ctx = { pinnedSignatureKeysNative: vi.fn(async () => pin) };
    await expect(pinned.call(ctx, 'Bob', 'web-1')).resolves.toEqual(pin);
    expect(ctx.pinnedSignatureKeysNative).toHaveBeenCalledWith('Bob', 'web-1');
  });

  // The "no pin" line is Rust's, once; this seam adds no second copy of it.
  it('answers null for a device never seen, without a second log line', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const ctx = { pinnedSignatureKeysNative: vi.fn(async () => null) };
    await expect(pinned.call(ctx, 'Bob', 'web-2')).resolves.toBeNull();
    expect(debug).not.toHaveBeenCalled();
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
    const ctx = { removalEpochsNative: vi.fn(async () => [3, 7]) };
    await expect(removal.call(ctx, 'g1', 'Bob')).resolves.toEqual([3, 7]);
    expect(ctx.removalEpochsNative).toHaveBeenCalledWith('g1', 'Bob');
  });
});

// THE REPAIR OF A LEAF STILL IN THE TREE IS ONE COMMIT (Remove + Add), vetted before anything is
// staged - the Rust half and its Welcome are tested in tests/device_binding.rs.
describe('BaseMlsService.replaceMember - one commit, vetted first', () => {
  const replace = (
    BaseMlsService.prototype as unknown as {
      replaceMember: (
        g: string,
        d: { keyPackage: Uint8Array; userId: string; deviceId: string },
        exclude?: string[]
      ) => Promise<{ welcome?: Uint8Array; ratchetTree?: Uint8Array }>;
    }
  ).replaceMember;
  const ctxWith = (verdict: KeyPackageVerdict) => {
    const staged = { commit: new Uint8Array([1]), welcome: new Uint8Array([2]), groupInfo: null };
    return {
      vetKeyPackage: proto.vetKeyPackage,
      vetKeyPackageNative: vi.fn(async () => verdict),
      stageReplaceDevice: vi.fn(async () => staged),
      handOverDeviceEvents: vi.fn(async () => {}),
      runCommitTransaction: vi.fn(
        async (
          _g: string,
          stage: (intent: Uint8Array) => Promise<typeof staged>,
          _opts?: { excludeDeviceIds?: string[]; exportTree?: boolean }
        ) => {
          const s = await stage(INTENT);
          return { welcome: s.welcome, ratchetTree: new Uint8Array([4]) };
        }
      ),
    };
  };

  it('refuses a changed key with the typed error and stages nothing', async () => {
    const ctx = ctxWith('signature-key-changed');
    await expect(replace.call(ctx, 'g1', device)).rejects.toBeInstanceOf(DeviceTrustRefusedError);
    expect(ctx.runCommitTransaction).not.toHaveBeenCalled();
    expect(ctx.stageReplaceDevice).not.toHaveBeenCalled();
  });

  // A REPLACEMENT GOES THROUGH THE GATE LIKE EVERY COMMIT, SO ITS STAGE RECORDS THE INTENT: a stage
  // with no record is cleared as never sent, and a replacement whose answer was lost could not be
  // resubmitted.
  it('stages the replacement for the identity the package was fetched for, in one transaction', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const ctx = ctxWith('pinned');
    const out = await replace.call(ctx, 'g1', device, ['Bob:web-1']);
    expect(ctx.stageReplaceDevice).toHaveBeenCalledWith(
      'g1',
      'Bob:web-1',
      device.keyPackage,
      INTENT
    );
    expect(ctx.runCommitTransaction).toHaveBeenCalledTimes(1);
    expect(ctx.runCommitTransaction.mock.calls[0][2]).toEqual({
      excludeDeviceIds: ['Bob:web-1'],
      exportTree: true,
    });
    expect(out.welcome).toEqual(new Uint8Array([2]));
    // As every own Add: the device events this commit recorded go to the notices.
    expect(ctx.handOverDeviceEvents).toHaveBeenCalledWith('own add');
    info.mockRestore();
  });
});
