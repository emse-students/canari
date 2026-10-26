// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import type { RefusedAdmit } from '$lib/mls-client/mlsDeliveryApi';

/**
 * AN ADD'S ANSWER NAMES ONLY THE DEVICES THE GATE ADMITTED (DEV-3, 2026-10-25).
 *
 * The commit transaction returns `notAdmitted` - devices the accepted commit put in the tree that the
 * gate did not record, for a reason no Welcome gets past (a device revoked while the Add was in
 * flight). Every caller welcomes what the Add hands it: `welcome` for a one-device Add,
 * `addedDeviceIds` for a bulk one. So a device not admitted gets neither, and the one-device Add says
 * why instead.
 */

const proto = BaseMlsService.prototype as unknown as Record<string, unknown>;
const G = 'g-1';
const WELCOME = new Uint8Array([3]);
const TREE = new Uint8Array([7]);
const revoked = (userId: string, deviceId: string): RefusedAdmit => ({
  userId,
  deviceId,
  reason: 'no_key_package',
});

/** A service whose commit transaction answers `notAdmitted`, everything else stubbed. */
function service(notAdmitted: RefusedAdmit[], addedDeviceIds: string[] = []) {
  const c: Record<string, unknown> = {
    vetKeyPackage: vi.fn(async () => ({ kind: 'admit' })),
    handOverDeviceEvents: vi.fn(async () => {}),
    runCommitTransaction: vi.fn(async () => ({
      welcome: WELCOME,
      ratchetTree: TREE,
      addedDeviceIds,
      skipped: [],
      notAdmitted,
    })),
  };
  for (const name of ['addMember', 'replaceMember', 'addMembersBulk']) c[name] = proto[name];
  return c as unknown as {
    addMember: (g: string, d: unknown, x?: string[]) => Promise<Record<string, unknown>>;
    replaceMember: (g: string, d: unknown, x?: string[]) => Promise<Record<string, unknown>>;
    addMembersBulk: (g: string, d: unknown[]) => Promise<Record<string, unknown>>;
  };
}

const device = { keyPackage: new Uint8Array([1]), userId: 'u-b', deviceId: 'd-b' };

describe('a one-device Add whose device the gate did not admit', () => {
  it.each(['addMember', 'replaceMember'] as const)(
    '%s hands out no Welcome and says why',
    async (method) => {
      const result = await service([revoked('u-b', 'd-b')])[method](G, device);

      expect(result).toEqual({ ratchetTree: TREE, notAdmitted: 'no_key_package' });
    }
  );

  it.each(['addMember', 'replaceMember'] as const)(
    '%s hands out the Welcome when the refusal names another device - matched by the PAIR',
    async (method) => {
      // Same device id under another account: not this device.
      const result = await service([revoked('u-other', 'd-b')])[method](G, device);

      expect(result).toEqual({ welcome: WELCOME, ratchetTree: TREE });
    }
  );
});

describe('a bulk Add some of whose devices the gate did not admit', () => {
  it('leaves them out of addedDeviceIds - the list every caller welcomes - and names them', async () => {
    const result = await service([revoked('u-b', 'd-b2')], ['d-b1', 'd-b2', 'd-c']).addMembersBulk(
      G,
      [
        { keyPackage: new Uint8Array([1]), userId: 'u-b', deviceId: 'd-b1' },
        { keyPackage: new Uint8Array([2]), userId: 'u-b', deviceId: 'd-b2' },
        { keyPackage: new Uint8Array([3]), userId: 'u-c', deviceId: 'd-c' },
      ]
    );

    expect(result.addedDeviceIds).toEqual(['d-b1', 'd-c']);
    expect(result.notAdmitted).toEqual([revoked('u-b', 'd-b2')]);
    expect(result.welcome).toBe(WELCOME);
  });
});
