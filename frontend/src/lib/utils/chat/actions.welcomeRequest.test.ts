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
      // Requester device must resolve to a KeyPackage so the add can proceed.
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'dev-1', keyPackage: new Uint8Array([7]) }]),
      // Leaf not yet in the tree -> no kick, straight to addMember.
      getGroupMemberIdentities: vi.fn().mockResolvedValue([]),
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
   * (`lastWelcomeSentAt`) is module state keyed by `groupId:deviceId` and nothing resets it between
   * tests, so a second case reusing a group that already received a Welcome hits the cooldown and
   * skips - passing or failing for a reason that has nothing to do with what it asserts.
   */
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
  // Its leaf is still in the tree, so it must be kicked before it can be re-added - and the routing
  // rows its fresh-start cleared must not talk the handler out of it.
  it('kicks a leaf the tree holds even when the routing table has lost its row', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'legit-user:dev-1']),
      getGroupMembers: vi.fn().mockResolvedValue([]),
    });
    const log = vi.fn();

    await run('g-kick-holds', mlsService, log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('leaf in MLS tree - kick + re-add'));
    expect(mlsService.getGroupMembers).not.toHaveBeenCalled();
  });

  // AND THE OTHER DIRECTION, WHICH IS WHY THIS IS NOT MERELY A TIDY-UP: the routing table listing a
  // device whose leaf was never added would have made the handler kick a leaf that is not there,
  // rotating the epoch for nothing on every single reconnect.
  it('does not kick when the routing table lists a device the tree never held', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self']),
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'legit-user', deviceId: 'dev-1' }]),
    });
    const log = vi.fn();

    await run('g-kick-routing', mlsService, log);

    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('kick + re-add'));
    expect(mlsService.addMember).toHaveBeenCalledTimes(1);
  });

  // A DESTRUCTIVE ACTION IS NOT TAKEN ON DOUBT. An unreadable tree is not a leaf sighting, so
  // nothing is removed; the Add still goes out, exactly as the swallowed catch here used to allow,
  // and the branch now says which fact it was missing.
  it('never kicks on an unreadable tree, and logs that it could not tell', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockRejectedValue(new Error('GroupNotFound')),
    });
    const log = vi.fn();

    await run('g-kick-unreadable', mlsService, log);

    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Tree of g-kick-u'));
    expect(mlsService.addMember).toHaveBeenCalledTimes(1);
  });

  // A FAILED KICK LEFT NO TRACE OF ITS OWN, and the line that followed claimed the removal anyway.
  // `kickStaleLeaf` swallowed both of its calls and then logged `[KICK] ... removed` regardless, so
  // the Add collided with a leaf the reader had just been told was gone - and the DuplicateSignature
  // downstream, under another tag, was the only evidence. Neither failure is promoted to a throw:
  // the callers' fall-through is deliberate, only the silence was not.
  it('reports both halves of a kick that removed nothing, and still attempts the add', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['legit-user:dev-1']),
      removeMemberDevice: vi.fn().mockRejectedValue(new Error('epoch moved under us')),
      kickStaleDevice: vi.fn().mockRejectedValue(new Error('delivery service down')),
    });
    const log = vi.fn();

    await run('g-kick-failed', mlsService, log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("still in g-kick-failed's tree"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Routing row for legit-user:dev-1'));
    // THE SUCCESS LINE MUST NOT BE EMITTED. This is the assertion the old code failed.
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining('Stale leaf legit-user:dev-1 removed from')
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('tree=still present, routing=still listed')
    );
    expect(mlsService.addMember).toHaveBeenCalledTimes(1);
  });

  // THE TWO HALVES FAIL INDEPENDENTLY AND NEED DIFFERENT REPAIRS - a leaf out of the tree with a
  // routing row still shipping to it is a different estate from the reverse. A summary saying
  // "partially" without naming the half leaves the reader where the silence did.
  it('names which half survived when only the routing row resists', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['legit-user:dev-1']),
      kickStaleDevice: vi.fn().mockRejectedValue(new Error('delivery service down')),
    });
    const log = vi.fn();

    await run('g-kick-routing-half', mlsService, log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('tree=cleared, routing=still listed'));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("still in g-kick-routing-half's"));
  });

  // AND THE ORDINARY CASE STILL SAYS SO PLAINLY, in the one spelling the classifier knows. A kick
  // is a repair, so `[KICK] ... removed` is `unexplained` by design and breaks `clean`: reaching it
  // at all is the finding. The spelling is therefore load-bearing, not cosmetic.
  it('claims the removal only when both halves actually succeeded', async () => {
    const mlsService = admissible({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['legit-user:dev-1']),
    });
    const log = vi.fn();

    await run('g-kick-clean', mlsService, log);

    expect(log).toHaveBeenCalledWith(
      '[KICK] Stale leaf legit-user:dev-1 removed from g-kick-clean'
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('PARTIALLY'));
  });
});
