import type { Conversation } from '$lib/types';
import { handleWelcomeRequest } from './actions';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

/** Active conversation for `groupId` so the readiness guard does not short-circuit. */
function activeConversations(groupId: string): Map<string, Conversation> {
  return new Map([
    [
      groupId,
      {
        id: groupId,
        contactName: groupId,
        name: 'Test',
        messages: [],
        lifecycle: 'active',
        mlsStateHex: null,
      } as Conversation,
    ],
  ]);
}

describe('handleWelcomeRequest - membership guard', () => {
  it('refuses to re-add a requester absent from dm_group_members (removed user)', async () => {
    const groupId = 'g-removed';
    const mlsService = createMlsServiceStub({
      getGroupMeta: vi.fn().mockResolvedValue({ name: 'Test', isGroup: true }),
      // Server source of truth: the requester is no longer a member.
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'still-here' }]),
    });

    await handleWelcomeRequest({
      mlsService,
      storage: null,
      userId: 'me',
      pin: 'pin',
      conversations: activeConversations(groupId),
      log: vi.fn(),
      requesterUserId: 'kicked-user',
      requesterDeviceId: 'dev-1',
      groupId,
    });

    expect(mlsService.getGroupUserMembers).toHaveBeenCalledWith(groupId);
    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
    expect(mlsService.acquireAddLock).not.toHaveBeenCalled();
  });

  it('fails closed when the member list is unavailable (network)', async () => {
    const groupId = 'g-network';
    const mlsService = createMlsServiceStub({
      getGroupMeta: vi.fn().mockResolvedValue({ name: 'Test', isGroup: true }),
      getGroupUserMembers: vi.fn().mockRejectedValue(new Error('network')),
    });

    await handleWelcomeRequest({
      mlsService,
      storage: null,
      userId: 'me',
      pin: 'pin',
      conversations: activeConversations(groupId),
      log: vi.fn(),
      requesterUserId: 'some-user',
      requesterDeviceId: 'dev-1',
      groupId,
    });

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
  });

  it('proceeds to add a requester still present in dm_group_members', async () => {
    const groupId = 'g-legit';
    const mlsService = createMlsServiceStub({
      getGroupMeta: vi.fn().mockResolvedValue({ name: 'Test', isGroup: true }),
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'legit-user' }]),
      // Requester device must resolve to a KeyPackage so the add can proceed.
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'dev-1', keyPackage: new Uint8Array([7]) }]),
      // Leaf not yet in the tree -> no kick, straight to addMember.
      getGroupMembers: vi.fn().mockResolvedValue([]),
      // addMember now runs the whole staged transaction and returns the Welcome + ratchet tree.
      addMember: vi
        .fn()
        .mockResolvedValue({ welcome: new Uint8Array([1]), ratchetTree: new Uint8Array([2]) }),
    });

    await handleWelcomeRequest({
      mlsService,
      storage: null,
      userId: 'me',
      pin: 'pin',
      conversations: activeConversations(groupId),
      log: vi.fn(),
      requesterUserId: 'legit-user',
      requesterDeviceId: 'dev-1',
      groupId,
    });

    expect(mlsService.addMember).toHaveBeenCalledTimes(1);
    expect(mlsService.registerMember).toHaveBeenCalledWith(groupId, 'legit-user');
  });
});
