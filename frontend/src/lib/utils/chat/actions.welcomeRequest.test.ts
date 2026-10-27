// @vitest-environment happy-dom
import type { Conversation } from '$lib/types';
import { handleWelcomeRequest } from './actions';
import { recordWelcomeSent, resetWelcomeSent } from './welcomeSent';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { resetReportedRefusedDeviceSkips } from '$lib/mls-client/refusedDevices';
import {
  DeviceTrustRefusedError,
  resetReportedDeviceTrustRefusals,
} from '$lib/mls-client/deviceTrust';

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
      deviceKeyB64: 'pin',
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
      deviceKeyB64: 'pin',
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
      // A device this one already saw: an unseen device of a member is asked about, never re-added.
      pinnedSignatureKeys: vi
        .fn()
        .mockResolvedValue({ keys: [new Uint8Array([7])], anchored: true, reaffirmations: 0 }),
      // Requester device must resolve to a KeyPackage so the add can proceed.
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'dev-1', keyPackage: new Uint8Array([7]) }]),
      // This device's leaf is not in the tree, its user's is (another device) -> a member's device,
      // no kick, straight to addMember.
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'legit-user:laptop']),
      // addMember now runs the whole staged transaction and returns the Welcome + ratchet tree.
      addMember: vi
        .fn()
        .mockResolvedValue({ welcome: new Uint8Array([1]), ratchetTree: new Uint8Array([2]) }),
    });

    await handleWelcomeRequest({
      mlsService,
      storage: null,
      userId: 'me',
      deviceKeyB64: 'pin',
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

// THE KICK IS THE DESTRUCTIVE HALF OF THIS HANDLER, so what it reads to decide matters more here
// than anywhere else. `member_identities`' Rustdoc: "a decision to remove a leaf reads this, never
// the routing table". It used to read the routing table.
describe('handleWelcomeRequest - the kick decision reads the tree, not the routing table', () => {
  /** Everything the handler needs to get as far as the leaf check, for a legitimate requester. */
  const admissible = (overrides = {}) =>
    createMlsServiceStub({
      getGroupMeta: vi.fn().mockResolvedValue({ name: 'Test', isGroup: true }),
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'legit-user' }]),
      // A device this one already saw: an unseen device of a member is asked about, never re-added.
      pinnedSignatureKeys: vi
        .fn()
        .mockResolvedValue({ keys: [new Uint8Array([7])], anchored: true, reaffirmations: 0 }),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'dev-1', keyPackage: new Uint8Array([7]) }]),
      addMember: vi
        .fn()
        .mockResolvedValue({ welcome: new Uint8Array([1]), ratchetTree: new Uint8Array([2]) }),
      ...overrides,
    });

  /**
   * EVERY TEST BELOW USES ITS OWN GROUP ID, AND THAT IS NOT COSMETIC. The post-Welcome cooldown
   * (`welcomeSent`) is module state keyed by `groupId:deviceId`, so a second case reusing a group
   * that already received a Welcome hits the cooldown and skips - passing or failing for a reason
   * that has nothing to do with what it asserts. It is reset before each case as well.
   */
  beforeEach(() => resetWelcomeSent());
  const run = (
    groupId: string,
    mlsService: ReturnType<typeof createMlsServiceStub>,
    log = vi.fn()
  ) =>
    handleWelcomeRequest({
      mlsService,
      storage: null,
      userId: 'me',
      deviceKeyB64: 'pin',
      conversations: activeConversations(groupId),
      log,
      requesterUserId: 'legit-user',
      requesterDeviceId: 'dev-1',
      groupId,
    });

  // The case the handler exists for: a device that lost its WASM state and asks to be let back in.
  // Its leaf is still in the tree, so it is REPLACED - Remove and Add in one commit - and the routing
  // rows its fresh-start cleared must not talk the handler out of it.
  it('replaces a leaf the tree holds even when the routing table has lost its row', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'legit-user:dev-1']),
      getGroupMembers: vi.fn().mockResolvedValue([]),
    });
    const log = vi.fn();

    await run('g-kick-holds', mlsService, log);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('leaf in MLS tree - remove + re-add in one commit')
    );
    expect(mlsService.getGroupMembers).not.toHaveBeenCalled();
    expect(mlsService.replaceMember).toHaveBeenCalledTimes(1);
  });

  // THE TREE IS READ UNDER THE ONE CANONICAL IDENTITY RUST USES: a leaf spelling the user half
  // differently is the same device, so it is replaced - an Add would only meet its key again.
  it('replaces a leaf whose credential spells the user half in another case', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'Legit-User:dev-1']),
    });

    await run('g-kick-case', mlsService);

    expect(mlsService.replaceMember).toHaveBeenCalledTimes(1);
    expect(mlsService.addMember).not.toHaveBeenCalled();
  });

  // A WELCOME SENT BY ANOTHER PATH IS STILL IN FLIGHT. A creation fan-out welcomed this device
  // seconds ago and it asked before the Welcome landed: its leaf is fresh, so the push and the pull
  // must not overlap into a replacement. Only the welcome_request path used to be remembered.
  it('does not replace a device another path welcomed seconds ago', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'legit-user:dev-1']),
    });
    const log = vi.fn();
    recordWelcomeSent('g-kick-in-flight', 'dev-1');

    await run('g-kick-in-flight', mlsService, log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('still joining, skip'));
    expect(mlsService.replaceMember).not.toHaveBeenCalled();
    expect(mlsService.addMember).not.toHaveBeenCalled();
  });

  // AND PAST THE COOLDOWN THE REPAIR NAMES WHICH CAUSE IT REPAIRS: a Welcome sent here and lost,
  // not a leaf from another session.
  it('names the Welcome another path sent when the repair comes after the cooldown', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'legit-user:dev-1']),
    });
    const log = vi.fn();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 45_000);
    recordWelcomeSent('g-kick-lost', 'dev-1');
    clock.mockReturnValue(now);

    try {
      await run('g-kick-lost', mlsService, log);
    } finally {
      clock.mockRestore();
    }

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('in one commit (last Welcome sent here 45s ago)')
    );
  });

  // AND THE OTHER DIRECTION: the routing table listing a device whose leaf was never added would
  // have made the handler remove a leaf that is not there, rotating the epoch for nothing on every
  // single reconnect. A plain Add goes out instead.
  it('does not replace when the routing table lists a device the tree never held', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'legit-user:laptop']),
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'legit-user', deviceId: 'dev-1' }]),
    });
    const log = vi.fn();

    await run('g-kick-routing', mlsService, log);

    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('remove + re-add'));
    expect(mlsService.replaceMember).not.toHaveBeenCalled();
    expect(mlsService.addMember).toHaveBeenCalledTimes(1);
  });

  // NOTHING IS TAKEN ON DOUBT. An unreadable tree is not a leaf sighting, so nothing is removed - and
  // it cannot say the requester's user is a member either, so nothing is added
  // (`automaticAdmission`). The branch says which fact it was missing.
  it('neither removes nor adds on an unreadable tree, and logs that it could not tell', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockRejectedValue(new Error('GroupNotFound')),
    });
    const log = vi.fn();

    await run('g-kick-unreadable', mlsService, log);

    expect(mlsService.replaceMember).not.toHaveBeenCalled();
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Tree of g-kick-u'));
    expect(mlsService.addMember).not.toHaveBeenCalled();
  });

  // THE REPAIR IS ONE COMMIT, NOT A KICK THEN AN ADD. Two commits left a window where the device
  // was out of the group and a departure was recorded for a device that never left; nothing here
  // removes a leaf on its own any more, and nothing clears the routing row ahead of the Add.
  it('removes nothing on its own: the leaf leaves in the same commit that re-adds it', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['legit-user:dev-1']),
    });
    const log = vi.fn();

    await run('g-kick-clean', mlsService, log);

    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.replaceMember).toHaveBeenCalledWith(
      'g-kick-clean',
      { keyPackage: new Uint8Array([7]), userId: 'legit-user', deviceId: 'dev-1' },
      ['legit-user:dev-1']
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('[KICK]'));
  });
});

// THE REPLACEMENT IS VETTED BEFORE THE LEAF IT REPLACES IS REMOVED. A device that lost its state
// comes back under its old id with a new key nothing vouches for: the Add would refuse it, and a
// kick taken first would have removed the device from the group for nothing.
describe('handleWelcomeRequest - a re-add the device key cannot justify', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWelcomeSent();
    resetReportedDeviceTrustRefusals();
    resetReportedRefusedDeviceSkips();
  });

  const requester = (overrides = {}) =>
    createMlsServiceStub({
      getGroupMeta: vi.fn().mockResolvedValue({ name: 'Test', isGroup: true }),
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'legit-user' }]),
      // A device this one already saw: an unseen device of a member is asked about, never re-added.
      pinnedSignatureKeys: vi
        .fn()
        .mockResolvedValue({ keys: [new Uint8Array([7])], anchored: true, reaffirmations: 0 }),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'dev-1', keyPackage: new Uint8Array([7]) }]),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'legit-user:dev-1']),
      ...overrides,
    });
  const run = (
    groupId: string,
    mlsService: ReturnType<typeof createMlsServiceStub>,
    log = vi.fn()
  ) =>
    handleWelcomeRequest({
      mlsService,
      storage: null,
      userId: 'me',
      deviceKeyB64: 'pin',
      conversations: activeConversations(groupId),
      log,
      requesterUserId: 'legit-user',
      requesterDeviceId: 'dev-1',
      groupId,
    });

  it('kicks nothing and adds nothing when the package carries a key never pinned for the device', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mlsService = requester({
      vetKeyPackage: vi.fn().mockResolvedValue('signature-key-changed'),
    });

    await run('g-trust-changed', mlsService);

    expect(mlsService.vetKeyPackage).toHaveBeenCalledWith(
      new Uint8Array([7]),
      'legit-user',
      'dev-1'
    );
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('kicks nothing for a package that names another device', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mlsService = requester({
      vetKeyPackage: vi.fn().mockResolvedValue('identity-mismatch'),
    });

    await run('g-trust-mismatch', mlsService);

    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.addMember).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('still replaces a device whose key is the pinned one, in one commit', async () => {
    const mlsService = requester({
      vetKeyPackage: vi.fn().mockResolvedValue('pinned'),
    });

    await run('g-trust-pinned', mlsService);

    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.replaceMember).toHaveBeenCalledWith(
      'g-trust-pinned',
      { keyPackage: new Uint8Array([7]), userId: 'legit-user', deviceId: 'dev-1' },
      ['legit-user:dev-1']
    );
  });

  it('says a refusal raised by the Add once, as a refusal and not as a failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.fn();
    const mlsService = requester({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'legit-user:laptop']),
      addMember: vi
        .fn()
        .mockRejectedValue(new DeviceTrustRefusedError('identity-mismatch', 'legit-user', 'dev-1')),
    });

    await run('g-trust-add', mlsService, log);

    expect(error).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('[WELCOME_REQ] Error for'));
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
    error.mockRestore();
  });

  // THE NEXT REQUEST SPENDS NO KEYPACKAGE: a key change under a kept id is refused again by every
  // package of that device, so it is remembered and the requester is told what lifts it.
  it('fetches nothing for a requester already refused for a changed key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mlsService = requester({
      vetKeyPackage: vi.fn().mockResolvedValue('signature-key-changed'),
      // The refusal is remembered against the pin it was judged by; no pin, nothing to remember.
      pinnedSignatureKeys: vi
        .fn()
        .mockResolvedValue({ keys: [new Uint8Array([1])], anchored: true, reaffirmations: 0 }),
    });

    await run('g-trust-remembered', mlsService);
    await run('g-trust-remembered', mlsService);

    expect(mlsService.fetchUserDevices).toHaveBeenCalledTimes(1);
    expect(mlsService.fetchDeviceKeyPackage).not.toHaveBeenCalled();
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-enrols under a new id'));
    error.mockRestore();
    warn.mockRestore();
  });
});

// A DUPLICATE SIGNATURE KEY IS NO LONGER A KICK. The Add met a leaf already carrying the key: the
// tree names the leaf that carries it, a leaf of THIS identity is replaced in ONE commit (no epoch
// without the device, so no departure), and a key on any other identity's leaf removes nothing.
describe('handleWelcomeRequest - a duplicate signature key', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWelcomeSent();
  });
  const duplicate = () => vi.fn().mockRejectedValue(new Error('AddMembers: DuplicateSignatureKey'));
  const requester = (overrides = {}) =>
    createMlsServiceStub({
      getGroupMeta: vi.fn().mockResolvedValue({ name: 'Test', isGroup: true }),
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'legit-user' }]),
      // A device this one already saw: an unseen device of a member is asked about, never re-added.
      pinnedSignatureKeys: vi
        .fn()
        .mockResolvedValue({ keys: [new Uint8Array([7])], anchored: true, reaffirmations: 0 }),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'dev-1', keyPackage: new Uint8Array([7]) }]),
      ...overrides,
    });
  const run = (groupId: string, mlsService: ReturnType<typeof createMlsServiceStub>) =>
    handleWelcomeRequest({
      mlsService,
      storage: null,
      userId: 'me',
      deviceKeyB64: 'pin',
      conversations: activeConversations(groupId),
      log: vi.fn(),
      requesterUserId: 'legit-user',
      requesterDeviceId: 'dev-1',
      groupId,
    });

  it('replaces a leaf of the same identity in one commit and welcomes it, removing nothing alone', async () => {
    const mlsService = requester({
      // The first read could not tell; the second, after the refusal, sees the leaf.
      getGroupMemberIdentities: vi
        .fn()
        // The admission read sees the user by another device; the leaf read could not tell; the read
        // after the refusal sees the leaf.
        .mockResolvedValueOnce(['me:self', 'legit-user:laptop'])
        .mockRejectedValueOnce(new Error('busy'))
        .mockResolvedValue(['me:self', 'legit-user:dev-1']),
      leafHoldingKeyOf: vi.fn().mockResolvedValue('legit-user:dev-1'),
      addMember: duplicate(),
    });

    await run('g-dup-same', mlsService);

    expect(mlsService.leafHoldingKeyOf).toHaveBeenCalledWith('g-dup-same', new Uint8Array([7]));
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    expect(mlsService.replaceMember).toHaveBeenCalledTimes(1);
    expect(mlsService.sendWelcome).toHaveBeenCalledTimes(1);
  });

  it('removes nothing when the key sits on another identity, and says so as an error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mlsService = requester({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'legit-user:dev-9']),
      leafHoldingKeyOf: vi.fn().mockResolvedValue('legit-user:dev-9'),
      addMember: duplicate(),
    });

    await run('g-dup-other', mlsService);

    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    expect(mlsService.replaceMember).not.toHaveBeenCalled();
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('DUPLICATE KEY HELD BY ANOTHER DEVICE')
    );
    error.mockRestore();
  });

  // THE TREE HOLDING THIS IDENTITY DOES NOT MAKE THE DUPLICATE ITS LEAF: replacing it would put the
  // device back on another device's key.
  it('does not replace when the identity arrived in the tree but another leaf holds the key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mlsService = requester({
      getGroupMemberIdentities: vi
        .fn()
        // The admission read sees the user by another device; the leaf read could not tell; the read
        // after the refusal sees the leaf.
        .mockResolvedValueOnce(['me:self', 'legit-user:laptop'])
        .mockRejectedValueOnce(new Error('busy'))
        .mockResolvedValue(['me:self', 'legit-user:dev-1', 'legit-user:dev-9']),
      leafHoldingKeyOf: vi.fn().mockResolvedValue('legit-user:dev-9'),
      addMember: duplicate(),
    });

    await run('g-dup-arrived', mlsService);

    expect(mlsService.replaceMember).not.toHaveBeenCalled();
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('DUPLICATE KEY HELD BY ANOTHER DEVICE')
    );
    error.mockRestore();
  });

  it('removes nothing when a replace itself meets the key: another identity holds it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mlsService = requester({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['legit-user:dev-1']),
      leafHoldingKeyOf: vi.fn().mockResolvedValue('other-user:dev-3'),
      replaceMember: duplicate(),
    });

    await run('g-dup-replace', mlsService);

    expect(mlsService.replaceMember).toHaveBeenCalledTimes(1);
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('DUPLICATE KEY HELD BY ANOTHER DEVICE')
    );
    error.mockRestore();
  });
});
