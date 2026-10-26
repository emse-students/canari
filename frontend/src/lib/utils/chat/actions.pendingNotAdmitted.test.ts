// @vitest-environment happy-dom
import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/utils/chat/groupSyncEligibility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/groupSyncEligibility')>()),
  resolveTerminalGroup: vi.fn(async (_m: unknown, groupId: string) => ({
    terminalId: groupId,
    groupMeta: { name: 'a::b', isGroup: false, deletedAt: null },
    hasChain: false,
  })),
}));

import { processPendingInvitations } from './actions';

/**
 * A DEVICE REVOKED WHILE A MEMBER'S SWEEP IS ADDING IT (DEV-3, 2026-10-25).
 *
 * Measured on the rig: the sweep's Add of a device its owner revoked mid-flight was ACCEPTED with the
 * admit dropped (`ADMIT_REFUSED reason=no_key_package`), the sweep sent the Welcome anyway (a 500,
 * then `Add error ... Could not send the secure invitation`), and every other group's invitation of
 * the same device asked the server again and was told `revoked` - six 404s and six lines for one
 * fact. The commit's answer said it first; one answer about a DEVICE answers every group.
 */
describe('a pending device the gate did not admit', () => {
  const invitation = (groupId: string) => ({
    id: `i-${groupId}`,
    userId: 'peer',
    deviceId: 'peer-dev',
    groupId,
    status: 'pending',
  });
  const GROUPS = ['g1', 'g2', 'g3'];

  function makeMls(overrides: Partial<IMlsService> = {}): IMlsService {
    return {
      getDeviceId: vi.fn().mockReturnValue('self-device'),
      // What the Add's premise check reads (`confirmPendingAddPremise`): nothing moved meanwhile.
      getEpoch: vi.fn(() => 2),
      runUnderMlsLock: vi.fn((fn: () => Promise<unknown>) => fn()),
      fetchCommitsSince: vi.fn(async () => ({ commits: [], activeEpoch: 2, belowFloor: false })),
      settleUnresolvedCommitFromLog: vi.fn(async () => 'none'),
      notifyCommitsApplied: vi.fn(),
      getDeviceMemberships: vi.fn().mockResolvedValue([]),
      pinnedSignatureKeys: vi
        .fn()
        .mockResolvedValue({ keys: [], anchored: false, reaffirmations: 0 }),
      getLocalGroups: vi.fn().mockReturnValue(GROUPS),
      getPendingInvitations: vi.fn().mockResolvedValue(GROUPS.map(invitation)),
      acquireAddLock: vi.fn().mockResolvedValue(true),
      releaseAddLock: vi.fn().mockResolvedValue(undefined),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      // The peer already holds another leaf, so its new device is added automatically.
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device', 'peer:old-phone']),
      fetchUserDevices: vi.fn().mockResolvedValue([]),
      fetchDeviceKeyPackage: vi.fn().mockResolvedValue({
        kind: 'package',
        device: { deviceId: 'peer-dev', keyPackage: new Uint8Array([1]) },
      }),
      deleteDeviceMembership: vi.fn().mockResolvedValue(undefined),
      addMember: vi.fn(),
      updateInvitationStatus: vi.fn().mockResolvedValue(undefined),
      registerMember: vi.fn().mockResolvedValue(undefined),
      sendWelcome: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as IMlsService;
  }

  const conversation = (id: string): Conversation =>
    ({
      id,
      contactName: id,
      name: 'a::b',
      messages: [],
      lifecycle: 'active',
      mlsStateHex: null,
    }) as Conversation;

  async function sweep(mlsService: IMlsService) {
    const log = vi.fn();
    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      deviceKeyB64: 'pin',
      conversations: new Map(GROUPS.map((g) => [g, conversation(g)])),
      requestReAdd: () => Promise.resolve(),
      log,
    });
    return log.mock.calls.flat().join('\n');
  }

  it('sends no Welcome, registers nobody, and answers the other groups from that answer', async () => {
    const mlsService = makeMls({
      addMember: vi.fn().mockResolvedValue({
        ratchetTree: new Uint8Array([7]),
        notAdmitted: 'no_key_package',
      }),
    } as Partial<IMlsService>);

    const lines = await sweep(mlsService);

    expect(mlsService.addMember).toHaveBeenCalledTimes(1);
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
    expect(mlsService.registerMember).not.toHaveBeenCalled();
    // Asked once, for the first group; the other two are answered from it.
    expect(mlsService.fetchDeviceKeyPackage).toHaveBeenCalledTimes(1);
    for (const g of GROUPS) {
      expect(mlsService.deleteDeviceMembership).toHaveBeenCalledWith('peer', 'peer-dev', g);
    }
    expect(lines).toContain('was not admitted by the commit gate (no_key_package) in g1');
    expect(lines).toContain('2 more invitation(s) of it retired this sweep from that answer');
    expect(lines).not.toContain('Add error');
    expect(lines).not.toContain('Welcome(s) sent');
  });

  it('a refusal about the PERSON in one group (`not_entitled`) settles no other group of the device', async () => {
    const mlsService = makeMls({
      addMember: vi
        .fn()
        .mockResolvedValueOnce({ ratchetTree: new Uint8Array([7]), notAdmitted: 'not_entitled' })
        .mockResolvedValue({ welcome: new Uint8Array([3]), ratchetTree: new Uint8Array([7]) }),
    } as Partial<IMlsService>);

    const lines = await sweep(mlsService);

    // g1 refused the person: no Welcome there. g2 and g3 are each asked and welcomed on their own.
    expect(mlsService.addMember).toHaveBeenCalledTimes(3);
    expect(mlsService.sendWelcome).toHaveBeenCalledTimes(2);
    expect(mlsService.deleteDeviceMembership).toHaveBeenCalledExactlyOnceWith(
      'peer',
      'peer-dev',
      'g1'
    );
    expect(lines).toContain('was not admitted by the commit gate (not_entitled) in g1');
    expect(lines).not.toContain('more invitation(s) of it retired');
  });

  it('a `revoked` key-package answer is asked ONCE for the whole sweep', async () => {
    const mlsService = makeMls({
      fetchDeviceKeyPackage: vi.fn().mockResolvedValue({ kind: 'none', reason: 'revoked' }),
    } as Partial<IMlsService>);

    const lines = await sweep(mlsService);

    expect(mlsService.fetchDeviceKeyPackage).toHaveBeenCalledTimes(1);
    expect(mlsService.deleteDeviceMembership).toHaveBeenCalledTimes(3);
    expect(lines.match(/cannot be added \(revoked\) -> cleanup/g)).toHaveLength(1);
    expect(lines).toContain('2 more invitation(s) of it retired this sweep from that answer');
  });

  it('an `expired` answer is NOT carried over - the device may publish before the next group', async () => {
    const mlsService = makeMls({
      fetchDeviceKeyPackage: vi.fn().mockResolvedValue({ kind: 'none', reason: 'expired' }),
    } as Partial<IMlsService>);

    const lines = await sweep(mlsService);

    expect(mlsService.fetchDeviceKeyPackage).toHaveBeenCalledTimes(3);
    expect(lines).not.toContain('more invitation(s) of it retired');
  });

  it('an admitted device is welcomed in every group, as before', async () => {
    const mlsService = makeMls({
      addMember: vi.fn().mockResolvedValue({
        welcome: new Uint8Array([3]),
        ratchetTree: new Uint8Array([7]),
      }),
    } as Partial<IMlsService>);

    const lines = await sweep(mlsService);

    expect(mlsService.sendWelcome).toHaveBeenCalledTimes(3);
    expect(mlsService.deleteDeviceMembership).not.toHaveBeenCalled();
    expect(lines).toContain('3 Welcome(s) sent.');
  });
});
