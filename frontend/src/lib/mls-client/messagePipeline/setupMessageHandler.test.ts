vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  purgeLegacyPlainMlsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/proto/codec', () => ({
  decodeAppMessage: vi.fn(() => ({ text: { body: 'hello-from-proto' }, messageId: 'mid-1' })),
  encodeAppMessage: vi.fn(() => new Uint8Array([1])),
  mkSystem: vi.fn(() => new Uint8Array([2])),
}));

vi.mock('$lib/envelope', () => ({
  serializeEnvelope: (x: unknown) => `env:${JSON.stringify(x)}`,
  mkTextEnvelope: (t: string) => ({ plain: t }),
}));

vi.mock('$lib/crypto/ChannelKeyVault', () => ({
  channelKeyManager: {
    getVault: vi.fn(() => ({ rotateKey: vi.fn().mockResolvedValue(undefined) })),
    decryptMessage: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  },
}));

vi.mock('$lib/services/ChannelService', () => ({
  ChannelService: class MockChannelService {
    markKeyDistributionReceived = vi.fn().mockResolvedValue(undefined);
    ackKeyDistribution = vi.fn().mockResolvedValue(undefined);
    getChannelKeyBootstrap = vi.fn();
    sendMessage = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: vi.fn((id: string) => `Name(${id})`),
}));

vi.mock('$lib/utils/chat/messageUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/messageUtils')>();
  return {
    ...actual,
    appMsgToEnvelope: vi.fn(() => ({ content: 'rendered', options: { messageId: 'mid-1' } })),
  };
});

vi.mock('$lib/utils/chat/recovery', () => ({
  requestReAdd: vi.fn().mockResolvedValue(undefined),
  cancelReAdd: vi.fn(),
  resetReAddCooldowns: vi.fn(),
}));

import { setupMessageHandler } from './setupMessageHandler';
import * as codec from '$lib/proto/codec';
import { createMlsServiceStub } from '../test/fixtures/mlsServiceStub';
import {
  createTestConversations,
  createTestMessageReactions,
  emptyConversation,
} from '../test/fixtures/conversationMap';

describe('setupMessageHandler (MLS inbound + channel events)', () => {
  const groupId = '11111111-1111-4111-8111-111111111111';

  function baseDeps(overrides: Record<string, unknown> = {}) {
    const conversations = createTestConversations([
      [groupId, emptyConversation(groupId, { lifecycle: 'pending' })],
    ]);
    const mls = createMlsServiceStub({
      getUserGroups: vi.fn().mockResolvedValue([{ groupId, name: 'Test', isGroup: true }]),
    });
    return {
      mlsService: mls,
      storage: null,
      userId: 'user-a',
      deviceKeyB64: 'device-key',
      historyBaseUrl: 'https://hist',
      conversations,
      messageReactions: createTestMessageReactions(),
      recoveryTimers: new Map(),
      getSelectedContact: () => null,
      setSelectedContact: vi.fn(),
      saveConversation: vi.fn().mockResolvedValue(undefined),
      addMessageToChat: vi.fn().mockResolvedValue(undefined),
      loadHistoryForConversation: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
      ...overrides,
    };
  }

  it('registers onMessage and onChannelEvent on the MLS service', () => {
    const deps = baseDeps();
    setupMessageHandler(deps as any);
    expect(deps.mlsService.onMessage).toHaveBeenCalled();
    expect(typeof (deps.mlsService as any).onChannelEvent).toBe('function');
  });

  it('routes a key-distribution frame to the Graine handler, never to a conversation', async () => {
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    const distributionGroup = '22222222-2222-4222-8222-222222222222';
    mls.isDistributionGroup = vi.fn((g: string) => g === distributionGroup);
    mls.getLocalGroups = vi.fn().mockReturnValue([]);
    setupMessageHandler(deps as any);
    const cb = mls.onMessage.mock.calls[0][0];

    const acked = await cb('peer', new Uint8Array([1, 2]), distributionGroup, false);

    // The branch has to come FIRST. This group has no conversation, so the known-group path would
    // return without acknowledging and the seed would be redelivered for ever; and it is joined by
    // external commit, so the unknown-group path would ask for a Welcome nobody sends.
    expect(acked).toBe(true);
    expect(mls.routeDistributionFrame).toHaveBeenCalledWith(
      distributionGroup,
      'peer',
      new Uint8Array([1, 2])
    );
    expect(deps.addMessageToChat).not.toHaveBeenCalled();
  });

  it('retires the conversation the moment a Remove commit naming this device is applied', async () => {
    // THE POINT OF THE WHOLE MECHANISM. Before this, applying the commit that evicted us produced
    // the same `Ok(null)` as any other structural commit, so the client only learnt it had been
    // removed when a later send was refused - and the outbox read that refusal as transient and
    // retried it up its full backoff ladder against a group that would refuse every attempt.
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.isGroupActive = vi.fn().mockResolvedValue(false);
    setupMessageHandler(deps as any);
    const cb = mls.onMessage.mock.calls[0][0];

    const acked = await cb('peer', new Uint8Array([9, 9, 9]), groupId, false, undefined, true);

    expect(acked).toBe(true);
    expect(mls.isGroupActive).toHaveBeenCalledWith(groupId);
    expect(deps.conversations.get(groupId)!.lifecycle).toBe('removed');
  });

  it('does not ask about membership on an application message', async () => {
    // Only a commit can change membership. Asking on every frame would put a WASM call on the
    // hottest path in the app for an answer that cannot have changed.
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    setupMessageHandler(deps as any);
    const cb = mls.onMessage.mock.calls[0][0];

    await cb('peer', new Uint8Array([1, 2, 3]), groupId, false, undefined, false);

    expect(mls.isGroupActive).not.toHaveBeenCalled();
  });

  it('leaves the conversation alone when a commit does not remove this device', async () => {
    // Every add and every removal of SOMEBODY ELSE reaches the same line. Retiring on any commit
    // would delete a conversation on a peer joining it.
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.isGroupActive = vi.fn().mockResolvedValue(true);
    setupMessageHandler(deps as any);
    const cb = mls.onMessage.mock.calls[0][0];

    await cb('peer', new Uint8Array([4, 5, 6]), groupId, false, undefined, true);

    expect(deps.conversations.get(groupId)!.lifecycle).not.toBe('removed');
  });

  it('ACKs a frame that arrives after eviction, and asks for no repair', async () => {
    // The third path, and the expensive one. This frame is legitimate - in flight when the commit
    // landed, or routed by the registry the removal cleans best-effort - and it used to fall
    // through to the out-of-sync arm: `requestReAdd`, asking the server to undo a moderation
    // action, then a commit request that can only return 403.
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.isGroupActive = vi.fn().mockResolvedValue(false);
    mls.processIncomingMessage = vi.fn().mockRejectedValue(new Error(`EVICTED: ${groupId}`));
    setupMessageHandler(deps as any);
    const cb = mls.onMessage.mock.calls[0][0];

    const acked = await cb('peer', new Uint8Array([7, 7, 7]), groupId, false, undefined, false);

    // ACKed: leaving it queued would have the server redeliver it for ever.
    expect(acked).toBe(true);
    // And the frame is what taught us, so the conversation is retired here too - the commit that
    // said so may never have reached this device, which is exactly why the frame exists.
    expect(deps.conversations.get(groupId)!.lifecycle).toBe('removed');
    // Nothing asked to come back. `requestReAdd` reaches the network through `recovery.ts`; the
    // observable proof at this seam is that the recovery narration never happened.
    const said = (deps.log as any).mock.calls.flat().join(' ');
    expect(said).not.toContain('re-add');
    expect(said).not.toContain('Out-of-sync');
    expect(said).toContain('no repair owed');
  });

  it('propagates channel.member.joined to callback', async () => {
    const onChannelMemberJoined = vi.fn();
    const deps = baseDeps({ onChannelMemberJoined });
    setupMessageHandler(deps as any);
    const mlsAny = deps.mlsService as any;
    await mlsAny.onChannelEvent({
      type: 'channel.member.joined',
      data: { channelId: 'c1', channelName: 'general', workspaceId: 'ws1' },
    });
    expect(onChannelMemberJoined).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'c1', channelName: 'general', workspaceId: 'ws1' })
    );
  });

  it('epoch_rejected envoie un welcome_request (requestReAdd)', async () => {
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    setupMessageHandler(deps as any);
    await mls.onChannelEvent({
      type: 'epoch_rejected',
      data: { groupId, currentEpoch: 7 },
    });
    // New behaviour: requestReAdd is called (which sends sendWelcomeRequest).
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    expect(vi.mocked(requestReAdd)).toHaveBeenCalledWith(groupId, expect.anything());
  });

  it('processes Welcome for known placeholder conversation (not ready)', async () => {
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.processWelcome = vi.fn().mockResolvedValue(undefined);
    mls.getDeviceId = vi.fn().mockReturnValue('dev-x');
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;
    const ok = await onMsg('peer-user', new Uint8Array([1, 2]), groupId, true, undefined, false);
    expect(ok).toBe(true);
    expect(mls.processWelcome).toHaveBeenCalled();
    // AND IT DOES NOT REGISTER ITSELF. This asserted the opposite until 2026-09-05, pinning a
    // "safety net" that the delivery service refuses by construction: a joiner is not yet a member
    // of the group it is being welcomed into, and `assertCallerMayMutateMembership` only exempts
    // the creator of an EMPTY group. So the call was redundant when the inviter had already
    // registered this user and a 403 when it had not - the sole case it existed for - and it spoke
    // at ERROR level either way. GRP-5 and GRP-8 recorded PASS-DIRTY on nothing else.
    expect(mls.registerMember).not.toHaveBeenCalled();
    expect(deps.conversations.get(groupId)?.lifecycle).toBe('active');
  });

  it('routes plaintext channel.message.created to addMessageToChat', async () => {
    const channelKey = 'channel_chan-99';
    const conversations = createTestConversations([
      [
        channelKey,
        emptyConversation(channelKey, { lifecycle: 'active', conversationType: 'channel' }),
      ],
    ]);
    const deps = baseDeps({ conversations });
    setupMessageHandler(deps as any);
    const mls = deps.mlsService as any;
    await mls.onChannelEvent({
      type: 'channel.message.created',
      data: {
        channelId: 'chan-99',
        senderId: 'u-sender',
        plaintext: 'hi-channel',
        createdAt: new Date('2020-01-01').toISOString(),
        messageId: 'ext-1',
      },
    });
    expect(deps.addMessageToChat).toHaveBeenCalledWith(
      'u-sender',
      expect.any(String),
      channelKey,
      expect.objectContaining({ messageId: 'ext-1' })
    );
  });

  it('propagates channel.member.kicked with the removed user', async () => {
    const onChannelMemberKicked = vi.fn();
    const deps = baseDeps({ onChannelMemberKicked });
    setupMessageHandler(deps as any);
    await (deps.mlsService as any).onChannelEvent({
      type: 'channel.member.kicked',
      data: { channelId: 'c2', kickedBy: 'admin', kickedUserId: 'u-bob', isPrivate: true },
    });
    // kickedUserId is what tells the receiver the removal is theirs - dropping it made every
    // member purge the channel on somebody else's kick.
    expect(onChannelMemberKicked).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'c2',
        kickedBy: 'admin',
        kickedUserId: 'u-bob',
        channelIsPrivate: true,
      })
    );
  });

  it('normalises channel.member.removed onto the same callback', async () => {
    const onChannelMemberKicked = vi.fn();
    const deps = baseDeps({ onChannelMemberKicked });
    setupMessageHandler(deps as any);
    await (deps.mlsService as any).onChannelEvent({
      type: 'channel.member.removed',
      data: { channelId: 'c3', removedBy: 'admin', removedUserId: 'u-bob', isPrivate: false },
    });
    expect(onChannelMemberKicked).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'c3',
        kickedBy: 'admin',
        kickedUserId: 'u-bob',
        channelIsPrivate: false,
      })
    );
  });

  it('marks a community-wide removal by the absence of a channel', async () => {
    const onChannelMemberKicked = vi.fn();
    const deps = baseDeps({ onChannelMemberKicked });
    setupMessageHandler(deps as any);
    await (deps.mlsService as any).onChannelEvent({
      type: 'channel.member.kicked',
      data: { workspaceId: 'ws-1', kickedUserId: 'u-bob', kickedBy: 'admin' },
    });
    expect(onChannelMemberKicked).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '', workspaceId: 'ws-1', kickedUserId: 'u-bob' })
    );
  });

  it('logs when channel.message.created targets unknown channel', async () => {
    const deps = baseDeps();
    setupMessageHandler(deps as any);
    await (deps.mlsService as any).onChannelEvent({
      type: 'channel.message.created',
      data: {
        channelId: 'unknown',
        senderId: 'x',
        plaintext: 'n',
        createdAt: new Date().toISOString(),
      },
    });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('unknown channel'));
  });

  it('propagates channel.updated and workspace.updated', async () => {
    const onChannelUpdated = vi.fn();
    const onWorkspaceUpdated = vi.fn();
    const deps = baseDeps({ onChannelUpdated, onWorkspaceUpdated });
    setupMessageHandler(deps as any);
    const mls = deps.mlsService as any;
    await mls.onChannelEvent({
      type: 'channel.updated',
      data: { channelId: 'c1', name: 'new', workspaceId: 'w1' },
    });
    await mls.onChannelEvent({
      type: 'workspace.updated',
      data: { workspaceId: 'w1', imageMediaId: 'img1' },
    });
    expect(onChannelUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'c1', name: 'new' })
    );
    expect(onWorkspaceUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', imageMediaId: 'img1' })
    );
  });

  it('propagates workspace.deleted so members drop a community an admin removed', async () => {
    const onWorkspaceDeleted = vi.fn();
    const deps = baseDeps({ onWorkspaceDeleted });
    setupMessageHandler(deps as any);
    const mls = deps.mlsService as any;
    await mls.onChannelEvent({
      type: 'workspace.deleted',
      data: { workspaceId: 'w1', deletedBy: 'admin-1' },
    });
    expect(onWorkspaceDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', deletedBy: 'admin-1' })
    );
  });

  it('Welcome (NoMatchingKeyPackage) → republishes key material + externalJoin-first requestReAdd', async () => {
    const recovery = await import('$lib/utils/chat/recovery');
    vi.mocked(recovery.requestReAdd).mockClear();
    // Unique groupId: the NoMatchingKeyPackage failure counter is module-level.
    const gid = 'a1111111-1111-4111-8111-111111111111';
    const deps = baseDeps({
      conversations: createTestConversations([
        [gid, emptyConversation(gid, { lifecycle: 'pending' })],
      ]),
    });
    const mls = deps.mlsService as any;
    mls.processWelcome = vi
      .fn()
      .mockRejectedValue(new Error('NoMatchingKeyPackage - key consumed'));
    mls.getDeviceId = vi.fn().mockReturnValue('dev-x');
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array
    ) => Promise<boolean>;
    const ok = await onMsg('peer', new Uint8Array([1]), gid, true, undefined);
    expect(ok).toBe(true);
    // First detection: republish fresh key material, then drive the externalJoin-first seam.
    expect(mls.republishKeyMaterial).toHaveBeenCalledWith('device-key');
    expect(recovery.requestReAdd).toHaveBeenCalledWith(gid, expect.anything());
    // The self-heal seam owns welcome_request (fallback); the handler no longer calls it directly.
    expect(mls.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  it('Welcome (NoMatchingKeyPackage) → externalJoin-first recovery fires on the FIRST failure', async () => {
    const recovery = await import('$lib/utils/chat/recovery');
    vi.mocked(recovery.requestReAdd).mockClear();
    const gid = 'a2222222-2222-4222-8222-222222222222';
    const deps = baseDeps({
      conversations: createTestConversations([
        [gid, emptyConversation(gid, { lifecycle: 'pending' })],
      ]),
    });
    const mls = deps.mlsService as any;
    mls.processWelcome = vi.fn().mockRejectedValue(new Error('NoMatchingKeyPackage'));
    mls.getDeviceId = vi.fn().mockReturnValue('dev-x');
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array
    ) => Promise<boolean>;
    // No 3-strike wait: the peer-independent externalJoin (via requestReAdd) is attempted at once,
    // so a device whose peers have suspended re-adds can still self-heal.
    await onMsg('peer', new Uint8Array([1]), gid, true, undefined);
    expect(recovery.requestReAdd).toHaveBeenCalledWith(gid, expect.anything());
  });

  it('Welcome (GroupAlreadyExists) → noop, ACK', async () => {
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.processWelcome = vi.fn().mockRejectedValue(new Error('GroupAlreadyExists for this id'));
    mls.getDeviceId = vi.fn().mockReturnValue('dev-x');
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array
    ) => Promise<boolean>;
    const ok = await onMsg('peer', new Uint8Array([1]), groupId, true, undefined);
    expect(ok).toBe(true);
    // No sendWelcomeRequest and no thrown error.
    expect(mls.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  it('Welcome redelivered for already-held group → idempotent, no re-join or welcome_request', async () => {
    // Regression: a redelivered Welcome (server requeue after restart) for a group
    // we already hold locally must NOT call processWelcome (which would fail with
    // NoMatchingKeyPackage and trigger a destructive kick+re-add on the inviter side).
    const onGroupReady = vi.fn();
    const deps = baseDeps({ onGroupReady });
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.processWelcome = vi.fn().mockResolvedValue(groupId);
    mls.getDeviceId = vi.fn().mockReturnValue('dev-x');
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array
    ) => Promise<boolean>;
    const ok = await onMsg('peer', new Uint8Array([1]), groupId, true, undefined);
    expect(ok).toBe(true);
    expect(mls.processWelcome).not.toHaveBeenCalled();
    expect(mls.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(onGroupReady).toHaveBeenCalledWith(groupId);
  });

  it('Welcome for a HELD but EVICTED group → re-admission: forget the old state, process it', async () => {
    // HELD IS NOT THE SAME AS USABLE, and the guard above used to ask only the easier question. An
    // evicted group stays in the WASM store, so every Welcome re-admitting this device was dropped
    // as a redelivery and the device stayed out for good. This is reached by ANY legitimate
    // kick-and-re-add - precisely the outcome the duplicate-leaf repair is designed to produce - so
    // it outlives the GRP-4 race that exposed it. The old state is forgotten first: the new Welcome
    // must install on nothing, and the evicted state can neither read nor send anything anyway.
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.isGroupActive = vi.fn().mockResolvedValue(false);
    mls.processWelcome = vi.fn().mockResolvedValue(groupId);
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array
    ) => Promise<boolean>;

    const ok = await onMsg('peer', new Uint8Array([1]), groupId, true, undefined);

    expect(ok).toBe(true);
    expect(mls.forgetGroup).toHaveBeenCalledWith(groupId);
    expect(mls.processWelcome).toHaveBeenCalled();
  });

  it('Welcome for a held group whose membership cannot be READ → stays idempotent', async () => {
    // The third answer again: `null` is not an eviction. Treating an unreadable membership as one
    // would forget a group this device is still a member of and hand a redelivered Welcome a
    // KeyPackage that was consumed at the original join - turning a free no-op into a real loss.
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.isGroupActive = vi.fn().mockRejectedValue(new Error('store unreadable'));
    mls.processWelcome = vi.fn().mockResolvedValue(groupId);
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array
    ) => Promise<boolean>;

    const ok = await onMsg('peer', new Uint8Array([1]), groupId, true, undefined);

    expect(ok).toBe(true);
    expect(mls.forgetGroup).not.toHaveBeenCalled();
    expect(mls.processWelcome).not.toHaveBeenCalled();
  });

  it('commit for unknown group → buffered + recovery seam fired immediately', async () => {
    const unknownGroupId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    // Groupe absent du WASM local
    mls.getLocalGroups = vi.fn().mockReturnValue([]);
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    vi.mocked(requestReAdd).mockClear();
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;
    const result = await onMsg('peer', new Uint8Array([1]), unknownGroupId, false, undefined, true);
    // false → message kept in server queue (pending buffer)
    expect(result).toBe(false);
    // The single recovery seam is fired at once (no 10 s timer); it sends the welcome_request and
    // marks the group not-ready for the SYNC_WATCHDOG cadence.
    expect(vi.mocked(requestReAdd)).toHaveBeenCalledWith(unknownGroupId, expect.anything());
  });

  it('second frame for the same unknown group → no duplicate recovery (buffer dedup)', async () => {
    const unknownGroupId = 'bbbbbbbb-0000-4000-8000-000000000001';
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([]);
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    vi.mocked(requestReAdd).mockClear();
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;
    await onMsg('peer', new Uint8Array([1]), unknownGroupId, false, undefined, true);
    await onMsg('peer', new Uint8Array([2]), unknownGroupId, false, undefined, true);

    // Recovery is fired once on the first frame; the second frame only appends to the buffer.
    expect(vi.mocked(requestReAdd)).toHaveBeenCalledTimes(1);
  });

  it('known group, decryption fails → requestReAdd + ACK', async () => {
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    mls.processIncomingMessage = vi.fn().mockRejectedValue(new Error('WrongEpoch'));
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;
    const ok = await onMsg('peer', new Uint8Array([1]), groupId, false, undefined, false);
    expect(ok).toBe(true);
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    expect(vi.mocked(requestReAdd)).toHaveBeenCalledWith(groupId, expect.anything());
  });

  it('delivers decrypted app text for known group (non-welcome)', async () => {
    vi.mocked(codec.decodeAppMessage).mockReturnValueOnce({
      text: { body: 'hello-dm' },
      messageId: 'mid-dm',
    } as any);
    const deps = baseDeps();
    const mls = deps.mlsService as any;
    mls.processIncomingMessage = vi.fn().mockResolvedValue(new Uint8Array([9, 9]));
    // The group must be in getLocalGroups() to be processed (WASM = source of truth).
    mls.getLocalGroups = vi.fn().mockReturnValue([groupId]);
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;
    const ok = await onMsg('peer', new Uint8Array([1]), groupId, false, undefined, false);
    expect(ok).toBe(true);
    expect(mls.processIncomingMessage).toHaveBeenCalledWith(groupId, expect.any(Uint8Array));
    expect(deps.addMessageToChat).toHaveBeenCalledWith(
      'peer',
      'rendered',
      groupId,
      expect.objectContaining({})
    );
  });

  it('epoch gap web (WASM) with the commits pruned → forget + requestReAdd AT ONCE', async () => {
    // `belowFloor` is a PROOF that no later attempt can succeed, so the 30 s wait this test used to
    // assert bought nothing: a frozen outbox, one wasted round trip per arriving frame, and every
    // one of those frames ACKed and dropped meanwhile. That is how twelve messages were lost on
    // prod on 2026-09-02 (DM `7da231f8`). The clock still governs a rung-1 attempt that merely
    // FAILED - the case below this one.
    vi.useFakeTimers();
    const gid = 'c4444444-4444-4444-8444-444444444444';
    const deps = baseDeps({
      conversations: createTestConversations([
        [gid, emptyConversation(gid, { lifecycle: 'active' })],
      ]),
    });
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([gid]);
    mls.processIncomingMessage = vi
      .fn()
      .mockRejectedValue(new Error('Process error: epoch gap [msg_epoch=13, group_epoch=7]'));
    mls.forgetGroup = vi.fn();
    // Rung-1 replay cannot help here: the missing commits were pruned (belowFloor) -> rung-2.
    mls.fetchCommitsSince = vi
      .fn()
      .mockResolvedValue({ commits: [], activeEpoch: 20, belowFloor: true });
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    vi.mocked(requestReAdd).mockClear();
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;

    const ok1 = await onMsg('peer', new Uint8Array([1]), gid, false, undefined, false);

    // No clock was advanced between the frame and these assertions.
    expect(ok1).toBe(true);
    expect(mls.forgetGroup).toHaveBeenCalledWith(gid);
    expect(vi.mocked(requestReAdd)).toHaveBeenCalledWith(gid, expect.anything());
    vi.useRealTimers();
  });

  it('an epoch gap whose replay merely FAILED still waits out the threshold', async () => {
    // The other half of the same decision: nothing here says the commits are unobtainable, only
    // that this attempt did not land. Destroying local state on one bad answer would make every
    // transient failure a full re-Welcome.
    vi.useFakeTimers();
    const gid = 'c7777777-7777-4777-8777-777777777777';
    const deps = baseDeps({
      conversations: createTestConversations([
        [gid, emptyConversation(gid, { lifecycle: 'active' })],
      ]),
    });
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([gid]);
    mls.getEpoch = vi.fn().mockReturnValue(7);
    mls.processIncomingMessage = vi
      .fn()
      .mockRejectedValue(new Error('Process error: epoch gap [msg_epoch=13, group_epoch=7]'));
    mls.forgetGroup = vi.fn();
    // The log covers the range and has no hole: rung 1 is entitled to another go.
    mls.fetchCommitsSince = vi.fn().mockResolvedValue({
      commits: [{ baseEpoch: 7, proto: 'AQID' }],
      activeEpoch: 20,
      belowFloor: false,
    });
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    vi.mocked(requestReAdd).mockClear();
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;

    const ok1 = await onMsg('peer', new Uint8Array([1]), gid, false, undefined, false);
    expect(ok1).toBe(true);
    expect(mls.forgetGroup).not.toHaveBeenCalled();
    expect(vi.mocked(requestReAdd)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(31_000);
    await onMsg('peer', new Uint8Array([1]), gid, false, undefined, false);
    expect(mls.forgetGroup).toHaveBeenCalledWith(gid);
    expect(vi.mocked(requestReAdd)).toHaveBeenCalledWith(gid, expect.anything());
    vi.useRealTimers();
  });

  it('GAP_QUEUED with the commits pruned → forget + requestReAdd AT ONCE', async () => {
    vi.useFakeTimers();
    const gid = 'b3333333-3333-4333-8333-333333333333';
    const deps = baseDeps({
      conversations: createTestConversations([
        [gid, emptyConversation(gid, { lifecycle: 'active' })],
      ]),
    });
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([gid]);
    mls.processIncomingMessage = vi
      .fn()
      .mockRejectedValue(new Error(`GAP_QUEUED:${gid}:msg_epoch=4:group_epoch=2`));
    mls.forgetGroup = vi.fn();
    // Rung-1 replay cannot help here: the missing commits were pruned (belowFloor) -> rung-2.
    mls.fetchCommitsSince = vi
      .fn()
      .mockResolvedValue({ commits: [], activeEpoch: 20, belowFloor: true });
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    vi.mocked(requestReAdd).mockClear();
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;

    // The native gap arm reaches the same ladder, so it inherits the same proof: forget +
    // welcome_request on the FIRST frame, with no timer advanced.
    const ok1 = await onMsg('peer', new Uint8Array([1]), gid, false, undefined, false);
    expect(ok1).toBe(true);
    expect(mls.forgetGroup).toHaveBeenCalledWith(gid);
    expect(vi.mocked(requestReAdd)).toHaveBeenCalledWith(gid, expect.anything());
    vi.useRealTimers();
  });

  it('a recovery that never settles does not block the message callback', async () => {
    // Measured on the device 2026-08-06: `requestReAdd` never returned, the callback never
    // returned, `isDraining` stayed true and every later inbound message was enqueued and never
    // processed - no error, no line in the log. The callback must answer ACK/no-ACK on its own.
    const gid = 'b5555555-5555-4555-8555-555555555555';
    const deps = baseDeps({
      conversations: createTestConversations([
        [gid, emptyConversation(gid, { lifecycle: 'active' })],
      ]),
    });
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([gid]);
    mls.processIncomingMessage = vi
      .fn()
      .mockRejectedValue(new Error('SecretTreeError(TooDistantInTheFuture)'));
    mls.forgetGroup = vi.fn();
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    vi.mocked(requestReAdd).mockClear();
    vi.mocked(requestReAdd).mockReturnValue(new Promise<void>(() => {}));
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;

    const verdict = await Promise.race([
      onMsg('peer', new Uint8Array([1]), gid, false, undefined, false),
      new Promise((resolve) => setTimeout(() => resolve('BLOCKED'), 500)),
    ]);

    expect(verdict).toBe(true);
    expect(vi.mocked(requestReAdd)).toHaveBeenCalled();
    vi.mocked(requestReAdd).mockResolvedValue(undefined);
  });

  it('a generation too far ahead escalates at once instead of waiting on a replay that cannot help', async () => {
    const gid = 'b4444444-4444-4444-8444-444444444444';
    const deps = baseDeps({
      conversations: createTestConversations([
        [gid, emptyConversation(gid, { lifecycle: 'active' })],
      ]),
    });
    const mls = deps.mlsService as any;
    mls.getLocalGroups = vi.fn().mockReturnValue([gid]);
    // The native wrapper: `GAP_QUEUED` on the outside, the real cause inside. Same epoch on both
    // sides, so no commit exists to replay - the old code applied 0, called that healed, and ACKed.
    mls.processIncomingMessage = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `GAP_QUEUED:${gid}:Process error: ValidationError(UnableToDecrypt(SecretTreeError(TooDistantInTheFuture))) [msg_epoch=1, group_epoch=1]`
        )
      );
    mls.forgetGroup = vi.fn();
    mls.fetchCommitsSince = vi.fn();
    const { requestReAdd } = await import('$lib/utils/chat/recovery');
    vi.mocked(requestReAdd).mockClear();
    setupMessageHandler(deps as any);
    const onMsg = mls.onMessage.mock.calls[0][0] as (
      a: string,
      b: Uint8Array,
      c?: string,
      d?: boolean,
      e?: Uint8Array,
      f?: boolean
    ) => Promise<boolean>;

    // No threshold and no replay: every later frame from this sender fails identically, so waiting
    // 30 s only loses more of them.
    const ok = await onMsg('peer', new Uint8Array([1]), gid, false, undefined, false);
    expect(ok).toBe(true);
    expect(mls.fetchCommitsSince).not.toHaveBeenCalled();
    expect(mls.forgetGroup).toHaveBeenCalledWith(gid);
    expect(vi.mocked(requestReAdd)).toHaveBeenCalledWith(gid, expect.anything());
  });
});
